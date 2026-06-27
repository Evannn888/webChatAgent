import { signJWT } from '../_jwt.js';

/**
 * GET /api/auth/login → Serve local dev login form or redirect to Google OAuth.
 *
 * In dev mode (DEV_MODE=true or localhost), shows a simple email/name form.
 * In production, redirects to Google OAuth consent screen.
 */
export async function onRequestGet(context) {
  const isDevMode = context.env.DEV_MODE === 'true' ||
    new URL(context.request.url).hostname === 'localhost';

  if (isDevMode) {
    return new Response(DEV_LOGIN_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Production: redirect to Google OAuth
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: context.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${context.env.SITE_URL}/api/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
    state: state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

/**
 * POST /api/auth/login → Handle local dev login (email + name form).
 */
export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { email, name } = body;

    if (!email) {
      return Response.json({ error: 'Email is required' }, { status: 400 });
    }

    // Generate a stable ID from the email
    const id = 'dev_' + await hashString(email);

    // Upsert user in D1
    const result = await context.env.DB.prepare(`
      INSERT INTO user (id, email, name, image)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name
      RETURNING image
    `).bind(id, email, name || email.split('@')[0]).first();

    // Issue JWT session
    const jwt = await signJWT(
      { sub: id, email, name: name || email.split('@')[0], image: result?.image || null },
      context.env.JWT_SECRET,
    );

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      },
    });
  } catch (error) {
    console.error('Dev login error:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Simple SHA-256 hash of a string → hex, for generating a stable user ID.
 */
async function hashString(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const DEV_LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dev Login — WebChat Agent</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: #0f0f19; color: #f0f0f5;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: rgba(15, 15, 25, 0.72);
      backdrop-filter: blur(18px);
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      border-radius: 18px; padding: 32px;
      width: 90%; max-width: 380px;
      position: relative;
    }
    .back-btn {
      position: absolute; top: 16px; right: 16px;
      width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
      text-decoration: none; color: #6b6b82; border-radius: 50%;
      background: rgba(255,255,255,0.05); transition: all 0.2s; font-size: 14px;
    }
    .back-btn:hover { background: rgba(255,255,255,0.1); color: #f0f0f5; }
    h1 { font-size: 1.3rem; margin-bottom: 6px; }
    .subtitle { color: #6b6b82; font-size: 0.85rem; margin-bottom: 24px; }
    label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 6px; }
    input {
      width: 100%; padding: 10px 14px; margin-bottom: 16px;
      background: #1a1a2e; border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px; color: #f0f0f5; font-size: 0.9rem;
      outline: none; font-family: inherit;
    }
    input:focus { border-color: #a29bfe; box-shadow: 0 0 0 3px rgba(108,92,231,0.15); }
    button {
      width: 100%; padding: 12px;
      background: linear-gradient(135deg, #6c5ce7, #a29bfe);
      border: none; border-radius: 8px;
      color: #fff; font-size: 0.95rem; font-weight: 600;
      cursor: pointer; font-family: inherit;
    }
    button:hover { opacity: 0.9; }
    .error { color: #ff6b6b; font-size: 0.85rem; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <a href="/" class="back-btn" title="Back to chat">✕</a>
    <h1>🔧 Dev Login</h1>
    <p class="subtitle">Local development mode — no Google OAuth required.</p>
    <div id="error" class="error"></div>
    <label for="email">Email</label>
    <input type="email" id="email" placeholder="you@example.com" autofocus>
    <label for="name">Name (optional)</label>
    <input type="text" id="name" placeholder="Your Name">
    <button onclick="doLogin()">Sign In</button>
  </div>
  <script>
    async function doLogin() {
      const email = document.getElementById('email').value.trim();
      const name = document.getElementById('name').value.trim();
      if (!email) { document.getElementById('error').textContent = 'Email is required'; return; }
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, name }),
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        window.location.href = '/';
      } catch (err) {
        document.getElementById('error').textContent = err.message;
      }
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  </script>
</body>
</html>`;
