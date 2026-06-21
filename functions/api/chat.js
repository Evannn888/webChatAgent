import { decrypt } from './_shared.js';

/**
 * POST /api/chat → Proxy a streaming LLM request.
 *
 * Fetches the user's encrypted API key from D1, decrypts it,
 * and streams the response from the selected LLM provider.
 *
 * Body: { provider, model, messages: [{role, content}] }
 */
export async function onRequestPost(context) {
  const user = context.data.user;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await context.request.json();
  const { provider, model, messages, sessionId } = body;

  if (!provider || !model || !messages?.length) {
    return Response.json(
      { error: 'provider, model, and messages are required' },
      { status: 400 },
    );
  }

  // Fetch encrypted API key from D1
  const row = await context.env.DB.prepare(
    'SELECT key FROM api_key WHERE userId = ? AND provider = ? LIMIT 1',
  ).bind(user.sub, provider).first();

  if (!row) {
    return Response.json(
      { error: `No API key saved for ${provider}. Add one in Settings.` },
      { status: 400 },
    );
  }

  let apiKey;
  try {
    apiKey = await decrypt(row.key, context.env.ENCRYPTION_KEY);
  } catch {
    return Response.json(
      { error: 'Failed to decrypt API key. Please re-enter it in Settings.' },
      { status: 500 },
    );
  }

  // Save the user's message if sessionId is provided
  if (sessionId) {
    const userMsg = messages[messages.length - 1];
    context.waitUntil(
      context.env.DB.batch([
        context.env.DB.prepare('INSERT INTO message (id, session_id, role, content) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), sessionId, 'user', userMsg.content),
        context.env.DB.prepare('UPDATE session SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(sessionId)
      ])
    );
  }

  // Stream the LLM response
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let assistantContent = '';
      try {
        const gen = streamChat(provider, apiKey, model, messages);
        for await (const chunk of gen) {
          assistantContent += chunk;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (err) {
        const errMsg = `\n\n⚠️ **Error:** ${err.message || 'Unknown error'}`;
        assistantContent += errMsg;
        controller.enqueue(encoder.encode(errMsg));
      } finally {
        if (sessionId && assistantContent) {
          context.waitUntil(
            context.env.DB.prepare('INSERT INTO message (id, session_id, role, content) VALUES (?, ?, ?, ?)')
              .bind(crypto.randomUUID(), sessionId, 'assistant', assistantContent).run()
          );
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

/* ══════════════════════════════════════════════════════════════
   LLM Streaming — direct fetch + SSE parsing per provider.
   Same logic as the original llm.ts, consolidated here.
   ══════════════════════════════════════════════════════════════ */

/**
 * Fetch with a timeout to prevent hanging requests.
 */
async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function* streamChat(provider, apiKey, model, messages) {
  switch (provider) {
    case 'openai':
      yield* streamOpenAI(apiKey, model, messages);
      break;
    case 'claude':
      yield* streamAnthropic(apiKey, model, messages);
      break;
    case 'gemini':
      yield* streamGemini(apiKey, model, messages);
      break;
    case 'deepseek':
      yield* streamDeepSeek(apiKey, model, messages);
      break;
    case 'openrouter':
      yield* streamOpenRouter(apiKey, model, messages);
      break;
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/* ── OpenAI ────────────────────────────────────────────────── */

async function* streamOpenAI(apiKey, model, messages) {
  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  yield* parseSSE(res.body, makeReasoningExtractor());
}

/* ── Anthropic ─────────────────────────────────────────────── */

async function* streamAnthropic(apiKey, model, messages) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      ...(supportsThinking(model) ? { thinking: { type: 'enabled', budget_tokens: 8192 } } : {}),
      messages: messages.map((m) => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      })),
      stream: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  let thinking = false;
  yield* parseSSE(res.body, (json) => {
    // Handle API errors in stream
    if (json.type === 'error') {
      throw new Error(json.error?.message || 'Anthropic stream error');
    }
    if (json.type === 'content_block_delta') {
      // Handle thinking deltas
      if (json.delta?.thinking) {
        let chunk = '';
        if (!thinking) {
          thinking = true;
          chunk += '<think>\n';
        }
        chunk += json.delta.thinking;
        return chunk;
      }
      // Handle text deltas — close thinking block if open
      if (json.delta?.text) {
        let chunk = '';
        if (thinking) {
          thinking = false;
          chunk += '\n</think>\n\n';
        }
        chunk += json.delta.text;
        return chunk;
      }
    }
    // Handle start of thinking block signal
    if (json.type === 'content_block_start' && json.content_block?.type === 'thinking') {
      thinking = true;
      return '<think>\n';
    }
    return null;
  });
}

/* ── Google Gemini ─────────────────────────────────────────── */

async function* streamGemini(apiKey, model, messages) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }

  let thinking = false;
  yield* parseSSE(res.body, (json) => {
    const parts = json.candidates?.[0]?.content?.parts;
    if (!parts?.length) return null;

    const part = parts[0];
    // Handle thinking / thought content
    if (part.thought) {
      let chunk = '';
      if (!thinking) {
        thinking = true;
        chunk += '<think>\n';
      }
      chunk += part.thought;
      return chunk;
    }
    // Handle regular text — close thinking block if open
    if (part.text) {
      let chunk = '';
      if (thinking) {
        thinking = false;
        chunk += '\n</think>\n\n';
      }
      chunk += part.text;
      return chunk;
    }
    return null;
  });
}

/* ── Helpers ────────────────────────────────────────────────── */

/**
 * Check whether a model supports extended thinking.
 * Anthropic: Claude 3.5+ models. Enable for all claude- models.
 */
function supportsThinking(model) {
  // Claude models: enable thinking for claude-opus, claude-sonnet, claude-haiku
  if (/^claude-(opus|sonnet|haiku)/.test(model)) return true;
  // Default: off (avoid API errors on unsupported models)
  return false;
}

/* ── Reasoning extractor helper ─────────────────────────────── */

/**
 * Creates a stateful extractor that wraps reasoning_content / reasoning
 * deltas in <think>…</think> tags so the frontend can render them as a
 * collapsible "Thinking Process" block.
 */
function makeReasoningExtractor() {
  let thinking = false;

  return (json) => {
    const delta = json.choices?.[0]?.delta;
    if (!delta) return null;

    const reasoning = delta.reasoning_content || delta.reasoning;
    const content = delta.content;

    let chunk = '';

    if (reasoning) {
      if (!thinking) {
        thinking = true;
        chunk += '<think>\n';
      }
      chunk += reasoning;
    }

    if (content) {
      if (thinking) {
        thinking = false;
        chunk += '\n</think>\n\n';
      }
      chunk += content;
    }

    return chunk || null;
  };
}

/* ── DeepSeek (OpenAI-compatible) ──────────────────────────── */

async function* streamDeepSeek(apiKey, model, messages) {
  const res = await fetchWithTimeout('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${text}`);
  }

  yield* parseSSE(res.body, makeReasoningExtractor());
}

/* ── OpenRouter (OpenAI-compatible) ────────────────────────── */

async function* streamOpenRouter(apiKey, model, messages) {
  const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${text}`);
  }

  yield* parseSSE(res.body, makeReasoningExtractor());
}

/* ── Shared SSE parser ─────────────────────────────────────── */

async function* parseSSE(body, extractContent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      let json;
      try {
        json = JSON.parse(trimmed.slice(6));
      } catch {
        continue; // Skip malformed JSON chunks
      }

      // Detect API-level errors in stream
      if (json.type === 'error' || json.error) {
        const errMsg = typeof json.error === 'string' ? json.error : json.error?.message || 'API stream error';
        throw new Error(errMsg);
      }

      const content = extractContent(json);
      if (content) yield content;
    }
  }
}
