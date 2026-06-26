/**
 * Shared utilities for JWT authentication and AES-256-GCM encryption.
 * Uses only the Web Crypto API — zero npm dependencies.
 */

/* ══════════════════════════════════════════════════════════════
   JWT (HMAC-SHA256)
   ══════════════════════════════════════════════════════════════ */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/**
 * Import a hex-encoded secret as an HMAC-SHA256 CryptoKey.
 */
async function getHmacKey(secretHex) {
  const raw = hexToBytes(secretHex);
  return crypto.subtle.importKey(
    'raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

/**
 * Create a signed JWT with the given payload. Expires in 30 days.
 */
export async function signJWT(payload, secretHex) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + 60 * 60 * 24 * 30 };

  const segments = [
    b64url(JSON.stringify(header)),
    b64url(JSON.stringify(body)),
  ];
  const signingInput = segments.join('.');

  const key = await getHmacKey(secretHex);
  const sig = await crypto.subtle.sign('HMAC', key, ENC.encode(signingInput));
  segments.push(b64urlFromBuffer(sig));

  return segments.join('.');
}

/**
 * Verify a JWT and return its payload, or throw if invalid / expired.
 */
export async function verifyJWT(token, secretHex) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');

  const key = await getHmacKey(secretHex);
  const signingInput = parts[0] + '.' + parts[1];
  const signature = b64urlToBuffer(parts[2]);

  const valid = await crypto.subtle.verify('HMAC', key, signature, ENC.encode(signingInput));
  if (!valid) throw new Error('Invalid signature');

  const payload = JSON.parse(DEC.decode(b64urlToBuffer(parts[1])));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  return payload;
}

/* ══════════════════════════════════════════════════════════════
   Encryption (AES-256-GCM)
   ══════════════════════════════════════════════════════════════ */

/**
 * Import a hex-encoded 32-byte key for AES-256-GCM.
 */
async function getAesKey(keyHex) {
  const raw = hexToBytes(keyHex);
  return crypto.subtle.importKey(
    'raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a plaintext string → base64 string (iv + ciphertext w/ auth tag).
 */
export async function encrypt(plaintext, keyHex) {
  const key = await getAesKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = ENC.encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  // Prepend IV to ciphertext (auth tag is appended automatically by WebCrypto)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return bytesToBase64(combined);
}

/**
 * Decrypt a base64 payload produced by {@link encrypt}.
 */
export async function decrypt(payload, keyHex) {
  const key = await getAesKey(keyHex);
  const combined = base64ToBytes(payload);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return DEC.decode(decrypted);
}

/* ══════════════════════════════════════════════════════════════
   Encoding helpers
   ══════════════════════════════════════════════════════════════ */

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBuffer(str) {
  let padded = str.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4) padded += '=';
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
