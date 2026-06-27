export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('Hex string must have an even length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToBase64(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 4096) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 4096)));
  }
  return btoa(chunks.join(''));
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlFromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 4096) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 4096)));
  }
  return btoa(chunks.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBuffer(str) {
  let padded = str.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4) padded += '=';
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
