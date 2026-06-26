export async function onRequestGet(context) {
  const user = context.data.user;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const url = new URL(context.request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 100);
    const offset = Math.max(parseInt(url.searchParams.get('offset')) || 0, 0);

    const { results } = await context.env.DB.prepare(`
      SELECT id, title, model_id, created_at, updated_at 
      FROM session 
      WHERE user_id = ? 
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).bind(user.sub, limit, offset).all();

    return Response.json({ sessions: results, limit, offset });
  } catch (err) {
    console.error('Failed to list sessions:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
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
    console.error('Failed to create session:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
