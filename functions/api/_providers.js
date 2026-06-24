/* ══════════════════════════════════════════════════════════════
   LLM Streaming — direct fetch + SSE parsing per provider.
   Each generator yields { text: string } and/or { usage: object }.
   ══════════════════════════════════════════════════════════════ */

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

async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  
  const clientSignal = options.signal;
  const abortHandler = () => controller.abort(clientSignal?.reason || 'client_aborted');
  
  if (clientSignal) {
    if (clientSignal.aborted) {
      clearTimeout(timer);
      throw new DOMException('Aborted', 'AbortError');
    }
    clientSignal.addEventListener('abort', abortHandler);
  }

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.reason === 'timeout' || (err.name === 'AbortError' && err.message.includes('timeout'))) {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
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
    if (json.type === 'message_start' && json.message?.usage?.input_tokens) {
      usage = { input: json.message.usage.input_tokens, output: 0 };
      return null;
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

function supportsThinking(model) {
  return /^claude-(opus|sonnet|haiku)/.test(model);
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
        if (buffer.length > 1024 * 1024) throw new Error('SSE chunk too large, possible malformed stream');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          let json;
          try {
            json = JSON.parse(trimmed.slice(6));
          } catch {
            continue; 
          }

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
    try {
      await reader.cancel();
    } catch { /* ignore */ }
    reader.releaseLock();
  }
}
