import { verifyJWT } from './_shared.js';

/**
 * Auth middleware — runs before every /api/* handler.
 * Parses the JWT session cookie and attaches user data to context.data.
 * Public routes (login, callback) are allowed through without auth.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname;

  // Public routes — skip auth
  if (path.endsWith('/api/auth/login') || path.endsWith('/api/auth/callback')) {
    return context.next();
  }

  // CSRF protection — verify Origin on state-changing requests
  const method = context.request.method;
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    const origin = context.request.headers.get('Origin');
    const siteUrl = context.env.SITE_URL;
    if (siteUrl && origin) {
      const expected = new URL(siteUrl).origin;
      if (origin !== expected) {
        return Response.json({ error: 'Forbidden: origin mismatch' }, { status: 403 });
      }
    }
  }

  // Parse session JWT from cookie
  const cookie = context.request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;\s]+)/);

  if (match) {
    try {
      context.data.user = await verifyJWT(match[1], context.env.JWT_SECRET);
    } catch {
      // Invalid or expired token — proceed without user
      context.data.user = null;
    }
  } else {
    context.data.user = null;
  }

  return context.next();
}
