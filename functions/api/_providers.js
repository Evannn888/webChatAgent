/* ══════════════════════════════════════════════════════════════
   LLM Streaming — direct fetch + SSE parsing per provider.
   Each generator yields { text }, { refusal } and/or { usage }.
   Input messages: [{ role, content: string, images?: [{ mediaType, data }] }]
   ══════════════════════════════════════════════════════════════ */

// Reasoning models can take a while to start responding and may think
// silently (no SSE data at all) for minutes, so both limits are generous.
const CONNECT_TIMEOUT_MS = 120_000; // until response headers arrive
const READ_TIMEOUT_MS = 300_000;    // max silence between stream chunks

export async function* streamLLM(provider, apiKey, model, messages, signal) {
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

async function fetchWithTimeout(url, options, timeoutMs = CONNECT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

  // Keep the caller's signal linked for the whole response (headers AND body),
  // so a client disconnect also cancels an upstream stream that is mid-body.
  const clientSignal = options.signal;
  if (clientSignal) {
    if (clientSignal.aborted) {
      clearTimeout(timer);
      throw new DOMException('Aborted', 'AbortError');
    }
    clientSignal.addEventListener('abort', () => controller.abort(clientSignal.reason), { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (controller.signal.reason === 'timeout') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI-style messages: plain string content, or text + image_url parts when images are attached. */
function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (!m.images?.length) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...m.images.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.data}` },
        })),
      ],
    };
  });
}

/* ── OpenAI ────────────────────────────────────────────────── */

async function* streamOpenAI(apiKey, model, messages, signal) {
  yield* streamOpenAICompatible(apiKey, model, messages, 'https://api.openai.com/v1/chat/completions', 'OpenAI', signal);
}

/* ── Anthropic ─────────────────────────────────────────────── */

async function* streamAnthropic(apiKey, model, messages, signal) {
  const systemMsg = messages.find((m) => m.role === 'system')?.content;
  const chatMessages = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role,
    content: m.images?.length
      ? [
          ...m.images.map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          })),
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ]
      : m.content,
  }));

  const fallback = supportsRefusalFallback(model);
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
    },
    body: JSON.stringify({
      model,
      // Thinking tokens count toward max_tokens; 16K could cut long answers short.
      max_tokens: 64000,
      ...(systemMsg ? { system: systemMsg } : {}),
      // Claude 5.x: thinking is adaptive (budget_tokens is rejected with a 400).
      // display: 'summarized' so the reasoning summary streams into the <think> block.
      ...(supportsThinking(model) ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      // On a safety-classifier refusal, let the API re-run the request on a fallback model.
      ...(fallback ? { fallbacks: 'default' } : {}),
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
  let refused = false;
  yield* parseSSE(res.body, (json) => {
    if (json.type === 'message_start' && json.message?.usage?.input_tokens) {
      usage = { input: json.message.usage.input_tokens, output: 0 };
      return null;
    }
    if (json.type === 'message_delta' && json.delta?.stop_reason === 'refusal') {
      refused = true;
    }
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
    // A second thinking block (e.g. after a refusal fallback) must not open a nested <think>.
    if (json.type === 'content_block_start' && json.content_block?.type === 'thinking' && !thinking) {
      thinking = true;
      return { text: '<think>\n' };
    }
    return null;
  });
  if (refused) {
    yield { refusal: `${thinking ? '\n</think>\n\n' : ''}\n\n_[The model declined to answer this request.]_` };
  }
  if (usage) yield { usage };
}

/* ── Google Gemini ─────────────────────────────────────────── */

async function* streamGemini(apiKey, model, messages, signal) {
  const systemMsg = messages.find((m) => m.role === 'system')?.content;
  const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [
      ...(m.images || []).map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.data } })),
      ...(m.content ? [{ text: m.content }] : []),
    ],
  }));

  const body = { contents };
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg }] };
  }

  // API key goes in a header, not the URL, so it can't end up in request logs.
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
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
    if (json.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the request (${json.promptFeedback.blockReason})`);
    }
    if (json.usageMetadata) {
      const u = json.usageMetadata;
      // Thinking tokens are billed as output but reported separately from candidates.
      usage = {
        input: u.promptTokenCount || 0,
        output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
      };
    }

    // A chunk can carry several parts (thought + answer text, split text, ...).
    const parts = json.candidates?.[0]?.content?.parts;
    if (!parts?.length) return null;

    let chunk = '';
    for (const part of parts) {
      if (typeof part.text !== 'string' || !part.text) continue;
      if (part.thought) {
        // Thought summaries arrive as text parts flagged with `thought: true`.
        if (!thinking) { thinking = true; chunk += '<think>\n'; }
      } else if (thinking) {
        thinking = false;
        chunk += '\n</think>\n\n';
      }
      chunk += part.text;
    }
    return chunk ? { text: chunk } : null;
  });
  if (usage) yield { usage };
}

/* ── OpenAI-Compatible (OpenAI, DeepSeek, OpenRouter) ──────── */

async function* streamOpenAICompatible(apiKey, model, messages, baseUrl, providerName, signal) {
  const res = await fetchWithTimeout(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(messages),
      stream: true,
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
    // Some providers attach usage to a chunk that also carries content, so don't return early.
    if (json.usage) {
      usage = { input: json.usage.prompt_tokens, output: json.usage.completion_tokens };
    }
    const text = extractor(json);
    return text ? { text } : null;
  });
  if (usage) yield { usage };
}

/* ── Helpers ────────────────────────────────────────────────── */

function supportsThinking(model) {
  return /^claude-(fable|opus|sonnet|haiku)/.test(model);
}

// Server-side refusal fallback (fallbacks: 'default') — not available on Haiku.
function supportsRefusalFallback(model) {
  return /^claude-(fable|opus|sonnet)-5/.test(model);
}

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

function parseSSELine(rawLine, extractContent) {
  const line = rawLine.trim();
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return null;

  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }

  if (json.type === 'error' || json.error) {
    const errMsg = typeof json.error === 'string' ? json.error : json.error?.message || 'API stream error';
    throw new Error(errMsg);
  }
  return extractContent(json);
}

async function* parseSSE(body, extractContent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stalled = false;
  let readTimer = null;

  const resetReadTimer = () => {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      stalled = true;
      reader.cancel().catch(() => {});
    }, READ_TIMEOUT_MS);
  };

  try {
    resetReadTimer();
    while (true) {
      const { done, value } = await reader.read();
      // A stalled stream used to end silently, leaving a truncated (or empty) answer.
      if (stalled) {
        throw new Error(`The provider stopped sending data for ${READ_TIMEOUT_MS / 1000}s; the response may be incomplete.`);
      }
      resetReadTimer();

      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();

      const lines = buffer.split('\n');
      buffer = done ? '' : lines.pop();
      if (buffer.length > 1024 * 1024) {
        throw new Error('Response too large. The model may have produced a malformed response.');
      }

      for (const line of lines) {
        const content = parseSSELine(line, extractContent);
        if (content) yield content;
      }
      if (done) break;
    }
  } finally {
    clearTimeout(readTimer);
    try {
      await reader.cancel();
    } catch { /* ignore */ }
    reader.releaseLock();
  }
}
