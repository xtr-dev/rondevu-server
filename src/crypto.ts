/**
 * Crypto utilities for stateless peer authentication
 * Uses Web Crypto API for compatibility with both Node.js and Cloudflare Workers
 */

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12; // 96 bits for GCM
const KEY_LENGTH = 32; // 256 bits

/**
 * Generates a random peer ID (16 bytes = 32 hex chars)
 */
export function generatePeerId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generates a random secret key for encryption (32 bytes = 64 hex chars)
 */
export function generateSecretKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to base64 string
 */
function bytesToBase64(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (byte) =>
    String.fromCodePoint(byte)
  ).join('');
  return btoa(binString);
}

/**
 * Convert base64 string to Uint8Array
 */
function base64ToBytes(base64: string): Uint8Array {
  const binString = atob(base64);
  return Uint8Array.from(binString, (char) => char.codePointAt(0)!);
}

/**
 * Encrypts a peer ID using the server secret key
 * Returns base64-encoded encrypted data (IV + ciphertext)
 */
export async function encryptPeerId(peerId: string, secretKeyHex: string): Promise<string> {
  const keyBytes = hexToBytes(secretKeyHex);

  if (keyBytes.length !== KEY_LENGTH) {
    throw new Error(`Secret key must be ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes)`);
  }

  // Import key
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: ALGORITHM, length: 256 },
    false,
    ['encrypt']
  );

  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // Encrypt peer ID
  const encoder = new TextEncoder();
  const data = encoder.encode(peerId);

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    data
  );

  // Combine IV + ciphertext and encode as base64
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return bytesToBase64(combined);
}

/**
 * Decrypts an encrypted peer ID secret
 * Returns the plaintext peer ID or throws if decryption fails
 */
export async function decryptPeerId(encryptedSecret: string, secretKeyHex: string): Promise<string> {
  try {
    const keyBytes = hexToBytes(secretKeyHex);

    if (keyBytes.length !== KEY_LENGTH) {
      throw new Error(`Secret key must be ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes)`);
    }

    // Decode base64
    const combined = base64ToBytes(encryptedSecret);

    // Extract IV and ciphertext
    const iv = combined.slice(0, IV_LENGTH);
    const ciphertext = combined.slice(IV_LENGTH);

    // Import key
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: ALGORITHM, length: 256 },
      false,
      ['decrypt']
    );

    // Decrypt
    const decrypted = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (err) {
    throw new Error('Failed to decrypt peer ID: invalid secret or secret key');
  }
}

/**
 * Validates that a peer ID and secret match
 * Returns true if valid, false otherwise
 */
export async function validateCredentials(peerId: string, encryptedSecret: string, secretKey: string): Promise<boolean> {
  try {
    const decryptedPeerId = await decryptPeerId(encryptedSecret, secretKey);
    return decryptedPeerId === peerId;
  } catch {
    return false;
  }
}
