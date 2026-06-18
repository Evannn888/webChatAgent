export async function onRequestGet(context) {
  const user = context.data.user;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { results } = await context.env.DB.prepare(`
      SELECT id, title, model_id, created_at, updated_at 
      FROM session 
      WHERE user_id = ? 
      ORDER BY updated_at DESC
    `).bind(user.sub).all();

    return Response.json({ sessions: results });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function onRequestPost(context) {
  const user = context.data.user;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await context.request.json();
    const title = body.title || 'New Chat';
    const model = body.model || null;
    const sessionId = crypto.randomUUID();

    await context.env.DB.prepare(`
      INSERT INTO session (id, user_id, title, model_id)
      VALUES (?, ?, ?, ?)
    `).bind(sessionId, user.sub, title, model).run();

    return Response.json({ session: { id: sessionId, title, model_id: model } });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
