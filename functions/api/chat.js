import { decrypt } from './_crypto.js';
import { streamLLM } from './_providers.js';

const ROLES = new Set(['system', 'user', 'assistant']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Keep only well-formed messages; images are only allowed on user turns. */
function normalizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && ROLES.has(m.role) && typeof m.content === 'string')
    .map((m) => {
      const images = m.role === 'user' && Array.isArray(m.images)
        ? m.images
            .filter((img) => img && IMAGE_TYPES.has(img.mediaType) && typeof img.data === 'string' && img.data)
            .map(({ mediaType, data }) => ({ mediaType, data }))
        : [];
      return images.length
        ? { role: m.role, content: m.content, images }
        : { role: m.role, content: m.content };
    });
}

/**
 * POST /api/chat → Proxy a streaming LLM request via SSE.
 *
 * Fetches the user's encrypted API key from D1, decrypts it,
 * and streams the response from the selected LLM provider.
 *
 * Response format: Server-Sent Events (SSE)
 *   event: text     → data: "chunk of text"
 *   event: refusal  → data: "note shown when the model declines"
 *   event: usage    → data: {"input":123,"output":456}
 *   event: error    → data: "error message" (not part of the answer text)
 *
 * Body: { provider, model, messages: [{role, content, images?}], sessionId? }
 */
export async function onRequestPost(context) {
  const user = context.data.user;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { provider, model, sessionId } = body;
  const messages = normalizeMessages(body.messages);

  if (!provider || !model || !messages.length) {
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

  // Validate sessionId ownership BEFORE streaming
  if (sessionId) {
    const session = await context.env.DB.prepare(
      'SELECT id FROM session WHERE id = ? AND user_id = ?'
    ).bind(sessionId, user.sub).first();

    if (!session) {
      return Response.json(
        { error: 'Forbidden: Session does not exist or belongs to another user' },
        { status: 403 }
      );
    }
  }

  // Aborted when the client goes away (Stop button, closed tab), which also
  // cancels the upstream provider request so it stops generating (and billing).
  const upstream = new AbortController();
  const requestSignal = context.request.signal;
  if (requestSignal) {
    if (requestSignal.aborted) upstream.abort();
    else requestSignal.addEventListener('abort', () => upstream.abort(), { once: true });
  }
  let clientGone = false;

  // Keep the invocation alive until the stream is finished and saved,
  // even if the client disconnects part-way through.
  let streamFinished;
  context.waitUntil(new Promise((resolve) => { streamFinished = resolve; }));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let assistantContent = '';
      let receivedFirstChunk = false;

      const write = (str) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(str));
        } catch {
          clientGone = true;
          upstream.abort();
        }
      };
      const sendEvent = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // SSE comment heartbeat: reasoning models can be silent for minutes.
      const heartbeat = setInterval(() => write(': ping\n\n'), 15000);

      try {
        const gen = streamLLM(provider, apiKey, model, messages, upstream.signal);
        for await (const chunk of gen) {
          if (clientGone) break;
          receivedFirstChunk = true;
          if (chunk.text) {
            assistantContent += chunk.text;
            sendEvent('text', chunk.text);
          }
          if (chunk.refusal) {
            assistantContent += chunk.refusal;
            sendEvent('refusal', chunk.refusal);
          }
          if (chunk.usage) {
            sendEvent('usage', chunk.usage);
          }
        }
      } catch (err) {
        // A client disconnect surfaces as an AbortError: nothing to report.
        if (!clientGone && err?.name !== 'AbortError') {
          const message = err?.message || 'Unknown error';
          sendEvent('error', message);
          // Keep the failure visible in the saved transcript when part of an answer was produced.
          if (receivedFirstChunk) assistantContent += `\n\n⚠️ **Error:** ${message}`;
        }
      } finally {
        clearInterval(heartbeat);
        if (sessionId && receivedFirstChunk) {
          const userMsg = [...messages].reverse().find(m => m.role === 'user');
          if (userMsg) {
            const persistMessages = () => context.env.DB.batch([
              context.env.DB.prepare('INSERT INTO message (id, session_id, role, content) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), sessionId, 'user', userMsg.content),
              context.env.DB.prepare('INSERT INTO message (id, session_id, role, content) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), sessionId, 'assistant', assistantContent),
              context.env.DB.prepare('UPDATE session SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(sessionId)
            ]);
            context.waitUntil(
              persistMessages().catch(err => {
                console.error('Failed to save messages (attempt 1):', err);
                return persistMessages().catch(retryErr => {
                  console.error('Failed to save messages (attempt 2, giving up):', retryErr);
                });
              })
            );
          }
        }
        if (!clientGone) {
          try { controller.close(); } catch { /* ignore */ }
        }
        streamFinished();
      }
    },
    cancel() {
      // The client stopped reading (pressed Stop / navigated away).
      clientGone = true;
      upstream.abort();
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
