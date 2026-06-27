import { signJWT } from '../_jwt.js';

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
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const cookies = context.request.headers.get('Cookie') || '';
    const stateCookieMatch = cookies.match(/(?:^|;\s*)oauth_state=([^;\s]+)/);
    const expectedState = stateCookieMatch ? stateCookieMatch[1] : null;

    if (error || !code) {
      return new Response('OAuth error: ' + (error || 'no code'), { status: 400 });
    }
    if (!state || state !== expectedState) {
      return new Response('OAuth error: invalid state parameter (CSRF attempt)', { status: 403 });
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

    // 5. Redirect with session cookie and clear oauth_state
    const redirectUrl = new URL('/', context.env.SITE_URL).toString();
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl,
        'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      },
    });
  } catch (err) {
    console.error('OAuth callback error:', err);
    return new Response('Internal server error during authentication', { status: 500 });
  }
}
