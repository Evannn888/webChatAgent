import { decrypt } from './_crypto.js';
import { streamLLM } from './_providers.js';

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

  // User message will be saved in background after stream succeeds

  // Stream the LLM response as SSE
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let assistantContent = '';
      let hasError = false;
      let receivedFirstChunk = false;

      const sendEvent = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
          const gen = streamLLM(provider, apiKey, model, messages, context.request.signal);
          for await (const chunk of gen) {
            receivedFirstChunk = true;
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
          hasError = true;
          const errMsg = `\n\n⚠️ **Error:** ${err.message || 'Unknown error'}`;
          assistantContent += errMsg;
          try { sendEvent('text', errMsg); } catch { /* ignore */ }
        } finally {
          if (sessionId && receivedFirstChunk) {
            const userMsg = messages[messages.length - 1];
            context.waitUntil(
              context.env.DB.batch([
                context.env.DB.prepare('INSERT INTO message (id, session_id, role, content) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), sessionId, 'user', userMsg.content),
                context.env.DB.prepare('INSERT INTO message (id, session_id, role, content) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), sessionId, 'assistant', assistantContent),
                context.env.DB.prepare('UPDATE session SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(sessionId)
              ]).catch(err => console.error('Failed to save messages:', err))
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
