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
    console.error('Session GET error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
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

    // Updatable fields: title, and model_id (the model this chat uses).
    const sets = [];
    const values = [];
    if (typeof body.title === 'string' && body.title.trim()) {
      sets.push('title = ?');
      values.push(body.title.trim().slice(0, 200));
    }
    if (typeof body.model_id === 'string' && body.model_id.trim()) {
      sets.push('model_id = ?');
      values.push(body.model_id.trim().slice(0, 100));
    }

    if (sets.length) {
      await context.env.DB.prepare(
        `UPDATE session SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
      ).bind(...values, sessionId, user.sub).run();
    }

    return Response.json({ success: true });
  } catch (err) {
    console.error('Session PATCH error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function onRequestDelete(context) {
  const user = context.data.user;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sessionId = context.params.id;

  try {
    const check = await context.env.DB.prepare('SELECT id FROM session WHERE id = ? AND user_id = ?').bind(sessionId, user.sub).first();
    if (!check) {
      return Response.json({ error: 'Session not found or unauthorized' }, { status: 404 });
    }

    await context.env.DB.batch([
      context.env.DB.prepare('DELETE FROM message WHERE session_id = ?').bind(sessionId),
      context.env.DB.prepare('DELETE FROM session WHERE id = ?').bind(sessionId)
    ]);

    return Response.json({ success: true });
  } catch (err) {
    console.error('Session DELETE error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
