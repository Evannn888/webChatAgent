import { hexToBytes, b64url, b64urlFromBuffer, b64urlToBuffer } from './_encoding.js';

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
