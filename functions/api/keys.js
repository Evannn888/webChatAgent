import { encrypt, decrypt } from './_shared.js';

/**
 * GET /api/keys → List saved API keys (masked) for the current user.
 */
export async function onRequestGet(context) {
  const user = context.data.user;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { results } = await context.env.DB.prepare(
    'SELECT id, provider, key, createdAt FROM api_key WHERE userId = ?',
  ).bind(user.sub).all();

  const masked = [];
  for (const row of results) {
    let raw;
    try {
      raw = await decrypt(row.key, context.env.ENCRYPTION_KEY);
    } catch {
      raw = '****';
    }
    masked.push({
      id: row.id,
      provider: row.provider,
      keyMasked: maskKey(raw),
      createdAt: row.createdAt,
    });
  }

  return Response.json({ keys: masked });
}

/**
 * POST /api/keys → Save or update an API key for the current user.
 * Body: { provider: string, key: string }
 */
export async function onRequestPost(context) {
  const user = context.data.user;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await context.request.json();
  const { provider, key } = body;

  if (!provider || !key) {
    return Response.json({ error: 'provider and key are required' }, { status: 400 });
  }

  const validProviders = ['openai', 'claude', 'gemini', 'deepseek', 'openrouter'];
  if (!validProviders.includes(provider)) {
    return Response.json(
      { error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` },
      { status: 400 },
    );
  }

  const encrypted = await encrypt(key, context.env.ENCRYPTION_KEY);

  // Check if a key already exists for this user + provider
  const existing = await context.env.DB.prepare(
    'SELECT id FROM api_key WHERE userId = ? AND provider = ? LIMIT 1',
  ).bind(user.sub, provider).first();

  if (existing) {
    await context.env.DB.prepare(
      'UPDATE api_key SET key = ?, updatedAt = ? WHERE id = ?',
    ).bind(encrypted, Date.now(), existing.id).run();
  } else {
    const id = crypto.randomUUID().replace(/-/g, '');
    const now = Date.now();
    await context.env.DB.prepare(
      'INSERT INTO api_key (id, userId, provider, key, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id, user.sub, provider, encrypted, now, now).run();
  }

  return Response.json({ success: true });
}

/**
 * DELETE /api/keys?id=... → Delete an API key by ID.
 */
export async function onRequestDelete(context) {
  const user = context.data.user;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');

  if (!id) {
    return Response.json({ error: 'id query param is required' }, { status: 400 });
  }

  // Delete key securely verifying ownership in one roundtrip
  const { meta } = await context.env.DB.prepare(
    'DELETE FROM api_key WHERE id = ? AND userId = ?'
  ).bind(id, user.sub).run();

  if (meta.changes === 0) {
    return Response.json({ error: 'Key not found' }, { status: 404 });
  }

  return Response.json({ success: true });
}

/* ── Helpers ────────────────────────────────────────────────── */

function maskKey(raw) {
  if (raw.length <= 8) return raw.slice(0, 4) + '****';
  return raw.slice(0, 4) + '****' + raw.slice(-4);
}
