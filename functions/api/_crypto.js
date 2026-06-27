import { hexToBytes, bytesToBase64, base64ToBytes } from './_encoding.js';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

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
