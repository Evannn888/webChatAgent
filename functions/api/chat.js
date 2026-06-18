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
              .bind(crypto.randomUUID(), sessionId, 'assistant', assistantContent)
              .run()
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
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
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

  yield* parseSSE(res.body, (json) => json.choices?.[0]?.delta?.content);
}

/* ── Anthropic ─────────────────────────────────────────────── */

async function* streamAnthropic(apiKey, model, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
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

  yield* parseSSE(res.body, (json) => {
    if (json.type === 'content_block_delta' && json.delta?.text) {
      return json.delta.text;
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

  const res = await fetch(
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

  yield* parseSSE(res.body, (json) =>
    json.candidates?.[0]?.content?.parts?.[0]?.text,
  );
}

/* ── DeepSeek (OpenAI-compatible) ──────────────────────────── */

async function* streamDeepSeek(apiKey, model, messages) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
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

  yield* parseSSE(res.body, (json) => json.choices?.[0]?.delta?.content);
}

/* ── OpenRouter (OpenAI-compatible) ────────────────────────── */

async function* streamOpenRouter(apiKey, model, messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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

  yield* parseSSE(res.body, (json) => json.choices?.[0]?.delta?.content);
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

      try {
        const json = JSON.parse(trimmed.slice(6));
        const content = extractContent(json);
        if (content) yield content;
      } catch {
        // skip malformed chunks
      }
    }
  }
}
