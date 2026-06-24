export async function onRequestGet(context) {
  const user = context.data.user;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sessionId = context.params.id;

  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare('SELECT id FROM session WHERE id = ? AND user_id = ?').bind(sessionId, user.sub),
      context.env.DB.prepare('SELECT role, content, created_at FROM message WHERE session_id = ? ORDER BY created_at ASC').bind(sessionId)
    ]);

    if (!results[0].results.length) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    return Response.json({ messages: results[1].results });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function onRequestPatch(context) {
  const user = context.data.user;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sessionId = context.params.id;

  try {
    const body = await context.request.json();

    if (body.title) {
      await context.env.DB.prepare(
        'UPDATE session SET title = ? WHERE id = ? AND user_id = ?'
      ).bind(body.title, sessionId, user.sub).run();
    }

    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function onRequestDelete(context) {
  const user = context.data.user;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sessionId = context.params.id;

  try {
    await context.env.DB.batch([
      context.env.DB.prepare('DELETE FROM message WHERE session_id IN (SELECT id FROM session WHERE id = ? AND user_id = ?)').bind(sessionId, user.sub),
      context.env.DB.prepare('DELETE FROM session WHERE id = ? AND user_id = ?').bind(sessionId, user.sub)
    ]);

    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
