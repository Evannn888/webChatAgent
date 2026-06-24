import { decrypt } from './_shared.js';

/**
 * POST /api/chat → Proxy a streaming LLM request via SSE.
 *
 * Fetches the user's encrypted API key from D1, decrypts it,
 * and streams the response from the selected LLM provider.
 *
 * Response format: Server-Sent Events (SSE)
 *   event: text   → data: "chunk of text"
 *   event: usage  → data: {"input":123,"output":456}
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

  // Stream the LLM response as SSE
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let assistantContent = '';

      const sendEvent = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const gen = streamChat(provider, apiKey, model, messages, context.request.signal);
        for await (const chunk of gen) {
          if (chunk.text) {
            assistantContent += chunk.text;
            sendEvent('text', chunk.text);
          }
          if (chunk.usage) {
            sendEvent('usage', chunk.usage);
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          // Client disconnected early, do nothing
          return;
        }
        const errMsg = `\n\n⚠️ **Error:** ${err.message || 'Unknown error'}`;
        assistantContent += errMsg;
        try { sendEvent('text', errMsg); } catch { /* ignore */ }
      } finally {
        if (sessionId && assistantContent && !context.request.signal.aborted) {
          context.waitUntil(
            context.env.DB.prepare('INSERT INTO message (id, session_id, role, content) VALUES (?, ?, ?, ?)')
              .bind(crypto.randomUUID(), sessionId, 'assistant', assistantContent).run()
          );
        }
        try { controller.close(); } catch { /* ignore */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

/* ══════════════════════════════════════════════════════════════
   LLM Streaming — direct fetch + SSE parsing per provider.
   Each generator yields { text: string } and/or { usage: object }.
   ══════════════════════════════════════════════════════════════ */

/**
 * Fetch with a timeout to prevent hanging requests.
 */
async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  
  const clientSignal = options.signal;
  const abortHandler = () => controller.abort(clientSignal?.reason || new Error('Aborted by client'));
  
  if (clientSignal) {
    if (clientSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    clientSignal.addEventListener('abort', abortHandler);
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      if (controller.signal.reason === 'timeout') {
        throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
      }
      throw err; // Client disconnected
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (clientSignal) {
      clientSignal.removeEventListener('abort', abortHandler);
    }
  }
}

async function* streamChat(provider, apiKey, model, messages, signal) {
  switch (provider) {
    case 'openai':
      yield* streamOpenAI(apiKey, model, messages, signal);
      break;
    case 'claude':
      yield* streamAnthropic(apiKey, model, messages, signal);
      break;
    case 'gemini':
      yield* streamGemini(apiKey, model, messages, signal);
      break;
    case 'deepseek':
      yield* streamOpenAICompatible(apiKey, model, messages, 'https://api.deepseek.com/v1/chat/completions', 'DeepSeek', signal);
      break;
    case 'openrouter':
      yield* streamOpenAICompatible(apiKey, model, messages, 'https://openrouter.ai/api/v1/chat/completions', 'OpenRouter', signal);
      break;
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/* ── OpenAI ────────────────────────────────────────────────── */

async function* streamOpenAI(apiKey, model, messages, signal) {
  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model, messages, stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  const extractor = makeReasoningExtractor();
  let usage = null;
  yield* parseSSE(res.body, (json) => {
    if (json.usage) {
      usage = { input: json.usage.prompt_tokens, output: json.usage.completion_tokens };
      return null;
    }
    const text = extractor(json);
    return text ? { text } : null;
  });
  if (usage) yield { usage };
}

/* ── Anthropic ─────────────────────────────────────────────── */

async function* streamAnthropic(apiKey, model, messages, signal) {
  const systemMsg = messages.find((m) => m.role === 'system')?.content;
  const chatMessages = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role,
    content: m.content,
  }));

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
      ...(systemMsg ? { system: systemMsg } : {}),
      ...(supportsThinking(model) ? { thinking: { type: 'enabled', budget_tokens: 8192 } } : {}),
      messages: chatMessages,
      stream: true,
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  let thinking = false;
  let usage = null;
  yield* parseSSE(res.body, (json) => {
    if (json.type === 'error') {
      throw new Error(json.error?.message || 'Anthropic stream error');
    }
    // Capture input tokens from message_start
    if (json.type === 'message_start' && json.message?.usage?.input_tokens) {
      usage = { input: json.message.usage.input_tokens, output: 0 };
      return null;
    }
    // Capture output tokens from message_delta
    if (json.type === 'message_delta' && json.usage?.output_tokens) {
      if (usage) usage.output = json.usage.output_tokens;
      else usage = { input: 0, output: json.usage.output_tokens };
      return null;
    }
    if (json.type === 'content_block_delta') {
      if (json.delta?.thinking) {
        let chunk = '';
        if (!thinking) { thinking = true; chunk += '<think>\n'; }
        chunk += json.delta.thinking;
        return { text: chunk };
      }
      if (json.delta?.text) {
        let chunk = '';
        if (thinking) { thinking = false; chunk += '\n</think>\n\n'; }
        chunk += json.delta.text;
        return { text: chunk };
      }
    }
    if (json.type === 'content_block_start' && json.content_block?.type === 'thinking') {
      thinking = true;
      return { text: '<think>\n' };
    }
    return null;
  });
  if (usage) yield { usage };
}

/* ── Google Gemini ─────────────────────────────────────────── */

async function* streamGemini(apiKey, model, messages, signal) {
  const systemMsg = messages.find((m) => m.role === 'system')?.content;
  const chatMessages = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = { contents: chatMessages };
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg }] };
  }

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }

  let thinking = false;
  let usage = null;
  yield* parseSSE(res.body, (json) => {
    // Capture usage metadata — don't return early, fall through to check for text
    if (json.usageMetadata) {
      usage = {
        input: json.usageMetadata.promptTokenCount || 0,
        output: json.usageMetadata.candidatesTokenCount || 0,
      };
    }

    const parts = json.candidates?.[0]?.content?.parts;
    if (!parts?.length) return null;

    const part = parts[0];
    if (part.thought) {
      let chunk = '';
      if (!thinking) { thinking = true; chunk += '<think>\n'; }
      chunk += part.thought;
      return { text: chunk };
    }
    if (part.text) {
      let chunk = '';
      if (thinking) { thinking = false; chunk += '\n</think>\n\n'; }
      chunk += part.text;
      return { text: chunk };
    }
    return null;
  });
  if (usage) yield { usage };
}

/* ── OpenAI-Compatible (DeepSeek, OpenRouter) ──────────────── */

async function* streamOpenAICompatible(apiKey, model, messages, baseUrl, providerName, signal) {
  const res = await fetchWithTimeout(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model, messages, stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${providerName} API error ${res.status}: ${text}`);
  }

  const extractor = makeReasoningExtractor();
  let usage = null;
  yield* parseSSE(res.body, (json) => {
    if (json.usage) {
      usage = { input: json.usage.prompt_tokens, output: json.usage.completion_tokens };
      return null;
    }
    const text = extractor(json);
    return text ? { text } : null;
  });
  if (usage) yield { usage };
}

/* ── Helpers ────────────────────────────────────────────────── */

/**
 * Check whether a model supports extended thinking.
 * Anthropic: Claude 3.5+ models. Enable for all claude- models.
 */
function supportsThinking(model) {
  return /^claude-(opus|sonnet|haiku)/.test(model);
}

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

/* ── Shared SSE parser ─────────────────────────────────────── */

async function* parseSSE(body, extractContent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
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
      if (done) {
        if (buffer.trim()) {
          // Process any remaining buffer
          if (buffer.trim().startsWith('data: ')) {
            try {
              const json = JSON.parse(buffer.trim().slice(6));
              const content = extractContent(json);
              if (content) yield content;
            } catch { /* ignore */ }
          }
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
