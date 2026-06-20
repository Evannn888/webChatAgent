import { signJWT } from '../_shared.js';

/**
 * GET /api/auth/callback → Handle Google OAuth callback.
 *
 * 1. Exchange authorization code for tokens
 * 2. Fetch user profile from Google
 * 3. Upsert user in D1
 * 4. Issue a signed JWT session cookie
 * 5. Redirect to app root
 */
export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error || !code) {
      return new Response('OAuth error: ' + (error || 'no code'), { status: 400 });
    }

    // 1. Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: context.env.GOOGLE_CLIENT_ID,
        client_secret: context.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${context.env.SITE_URL}/api/auth/callback`,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return new Response('Token exchange failed: ' + text, { status: 400 });
    }

    const tokens = await tokenRes.json();

    // 2. Fetch user profile
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userRes.ok) {
      return new Response('Failed to fetch user info', { status: 400 });
    }

    const gUser = await userRes.json();

    // 3. Upsert user in D1
    await context.env.DB.prepare(`
      INSERT INTO user (id, email, name, image)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        image = excluded.image
    `).bind(gUser.id, gUser.email, gUser.name, gUser.picture).run();

    // 4. Create JWT
    const jwt = await signJWT(
      { sub: gUser.id, email: gUser.email, name: gUser.name, image: gUser.picture },
      context.env.JWT_SECRET,
    );

    // 5. Redirect with session cookie
    return new Response(null, {
      status: 302,
      headers: {
        Location: context.env.SITE_URL + '/',
        'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      },
    });
  } catch (err) {
    return new Response('Server Error during callback: ' + err.message + '\n\nStack:\n' + err.stack, { status: 500 });
  }
}
