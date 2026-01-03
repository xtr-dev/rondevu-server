/**
 * Crypto utilities for credential generation and validation
 * Uses Web Crypto API for compatibility with both Node.js and Cloudflare Workers
 */

import { Buffer } from 'node:buffer';

// Username validation
// Rules: 4-32 chars, lowercase alphanumeric + dashes + periods, must start/end with alphanumeric
const USERNAME_REGEX = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const USERNAME_MIN_LENGTH = 4;
const USERNAME_MAX_LENGTH = 32;

/**
 * Generates a random credential name
 * Format: {adjective}-{noun}-{random}
 * Example: "brave-tiger-7a3f2b1c9d8e", "quick-river-9b2e4c1a5f3d"
 */
export function generateCredentialName(): string {
  const adjectives = [
    'brave', 'calm', 'eager', 'fancy', 'gentle', 'happy', 'jolly', 'kind',
    'lively', 'merry', 'nice', 'proud', 'quiet', 'swift', 'witty', 'young',
    'bright', 'clever', 'daring', 'fair', 'grand', 'humble', 'noble', 'quick'
  ];

  const nouns = [
    'tiger', 'eagle', 'river', 'mountain', 'ocean', 'forest', 'desert', 'valley',
    'thunder', 'wind', 'fire', 'stone', 'cloud', 'star', 'moon', 'sun',
    'wolf', 'bear', 'hawk', 'lion', 'fox', 'deer', 'owl', 'swan'
  ];

  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];

  // Generate 16-character hex suffix for uniqueness (8 bytes = 2^64 combinations)
  // With 576 adjective-noun pairs, total space: 576 × 2^64 ≈ 1.06 × 10^22 names
  // Birthday paradox collision at ~4.3 billion credentials (extremely safe for large deployments)
  // Increased from 6 bytes to 8 bytes for maximum collision resistance
  const random = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(random).map(b => b.toString(16).padStart(2, '0')).join('');

  return `${adjective}-${noun}-${hex}`;
}

/**
 * Generates a random secret (API key style)
 * Format: 64-character hex string (256 bits of entropy)
 * 256 bits provides optimal security for HMAC-SHA256 and future-proofs against brute force
 */
export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32)); // 32 bytes = 256 bits
  const secret = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Validation: Ensure output is exactly 64 characters and valid hex
  if (secret.length !== 64) {
    throw new Error('Secret generation failed: invalid length');
  }

  // Validate all characters are valid hex digits (0-9, a-f)
  for (let i = 0; i < secret.length; i++) {
    const c = secret[i];
    if ((c < '0' || c > '9') && (c < 'a' || c > 'f')) {
      throw new Error(`Secret generation failed: invalid hex character at position ${i}: '${c}'`);
    }
  }

  return secret;
}

// ===== Secret Encryption/Decryption (Database Storage) =====

/**
 * Convert hex string to byte array with validation
 * @param hex Hex string (must be even length)
 * @returns Uint8Array of bytes
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have even length');
  }

  // Pre-validate that all characters are valid hex digits (0-9, a-f, A-F)
  // This prevents parseInt from silently truncating invalid input like "0z" -> 0
  for (let i = 0; i < hex.length; i++) {
    const c = hex[i].toLowerCase();
    if ((c < '0' || c > '9') && (c < 'a' || c > 'f')) {
      throw new Error(`Invalid hex character at position ${i}: '${hex[i]}'`);
    }
  }

  const match = hex.match(/.{1,2}/g);
  if (!match) {
    throw new Error('Invalid hex string format');
  }

  return new Uint8Array(match.map(byte => {
    const parsed = parseInt(byte, 16);
    if (isNaN(parsed)) {
      throw new Error(`Invalid hex byte: ${byte}`);
    }
    return parsed;
  }));
}

/**
 * Encrypt a secret using AES-256-GCM with master key
 * Format: iv:ciphertext (all hex-encoded, auth tag included in ciphertext)
 *
 * @param secret The plaintext secret to encrypt
 * @param masterKeyHex The master encryption key (64-char hex = 32 bytes)
 * @returns Encrypted secret in format "iv:ciphertext"
 */
export async function encryptSecret(secret: string, masterKeyHex: string): Promise<string> {
  // Validate master key
  if (!masterKeyHex || masterKeyHex.length !== 64) {
    throw new Error('Master key must be 64-character hex string (32 bytes)');
  }

  // Convert master key from hex to bytes (with validation)
  const keyBytes = hexToBytes(masterKeyHex);

  // Import master key
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  // Generate random IV (12 bytes for AES-GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt secret
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);

  // AES-GCM returns ciphertext with auth tag already appended (no manual splitting needed)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    secretBytes
  );

  // Convert to hex: iv:ciphertext (ciphertext includes 16-byte auth tag at end)
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('');
  const ciphertextHex = Array.from(new Uint8Array(ciphertext))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return `${ivHex}:${ciphertextHex}`;
}

/**
 * Decrypt a secret using AES-256-GCM with master key
 *
 * @param encryptedSecret Encrypted secret in format "iv:ciphertext" (ciphertext includes auth tag)
 * @param masterKeyHex The master encryption key (64-char hex = 32 bytes)
 * @returns Decrypted plaintext secret
 */
export async function decryptSecret(encryptedSecret: string, masterKeyHex: string): Promise<string> {
  // Validate master key
  if (!masterKeyHex || masterKeyHex.length !== 64) {
    throw new Error('Master key must be 64-character hex string (32 bytes)');
  }

  // Parse encrypted format: iv:ciphertext
  const parts = encryptedSecret.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted secret format (expected iv:ciphertext)');
  }

  const [ivHex, ciphertextHex] = parts;

  // Validate IV length (must be 12 bytes = 24 hex characters for AES-GCM)
  if (ivHex.length !== 24) {
    throw new Error('Invalid IV length (expected 12 bytes = 24 hex characters)');
  }

  // Validate ciphertext length (must include at least 16-byte auth tag)
  // Minimum: 16 bytes for auth tag = 32 hex characters
  if (ciphertextHex.length < 32) {
    throw new Error('Invalid ciphertext length (must include 16-byte auth tag)');
  }

  // Convert from hex to bytes (with validation)
  const iv = hexToBytes(ivHex);
  const ciphertext = hexToBytes(ciphertextHex);

  // Convert master key from hex to bytes (with validation)
  const keyBytes = hexToBytes(masterKeyHex);

  // Import master key
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  // Decrypt (ciphertext already includes 16-byte auth tag at end)
  const decryptedBytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    ciphertext
  );

  // Convert to string
  const decoder = new TextDecoder();
  return decoder.decode(decryptedBytes);
}

// ===== HMAC Signature Generation and Verification =====

/**
 * Generate HMAC-SHA256 signature for request authentication
 * Uses Web Crypto API for compatibility with both Node.js and Cloudflare Workers
 *
 * @param secret The credential secret (hex string)
 * @param message The message to sign (typically: timestamp + method + params)
 * @returns Promise<string> Base64-encoded signature
 */
export async function generateSignature(secret: string, message: string): Promise<string> {
  // Convert secret from hex to bytes (with validation)
  const secretBytes = hexToBytes(secret);

  // Import secret as HMAC key
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Convert message to bytes
  const encoder = new TextEncoder();
  const messageBytes = encoder.encode(message);

  // Generate HMAC signature
  const signatureBytes = await crypto.subtle.sign('HMAC', key, messageBytes);

  // Convert to base64
  return Buffer.from(signatureBytes).toString('base64');
}

/**
 * Verify HMAC-SHA256 signature for request authentication
 * Uses crypto.subtle.verify() for constant-time comparison
 *
 * @param secret The credential secret (hex string)
 * @param message The message that was signed
 * @param signature The signature to verify (base64)
 * @returns Promise<boolean> True if signature is valid
 */
export async function verifySignature(secret: string, message: string, signature: string): Promise<boolean> {
  try {
    // Convert secret from hex to bytes (with validation)
    const secretBytes = hexToBytes(secret);

    // Import secret as HMAC key for verification
    const key = await crypto.subtle.importKey(
      'raw',
      secretBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // Convert message to bytes
    const encoder = new TextEncoder();
    const messageBytes = encoder.encode(message);

    // Convert signature from base64 to bytes
    const signatureBytes = Buffer.from(signature, 'base64');

    // Use Web Crypto API's verify() for constant-time comparison
    // This is cryptographically secure and resistant to timing attacks
    return await crypto.subtle.verify('HMAC', key, signatureBytes, messageBytes);
  } catch (error) {
    // Log error for debugging (helps identify implementation bugs)
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Canonical JSON serialization with sorted keys
 * Ensures deterministic output regardless of property insertion order
 * Must match client's canonicalJSON implementation exactly
 */
function canonicalJSON(obj: any, depth: number = 0): string {
  const MAX_DEPTH = 100;

  if (depth > MAX_DEPTH) {
    throw new Error('Object nesting too deep for canonicalization');
  }

  if (obj === null) return 'null';
  if (obj === undefined) return JSON.stringify(undefined);

  const type = typeof obj;

  if (type === 'function') throw new Error('Functions are not supported in RPC parameters');
  if (type === 'symbol' || type === 'bigint') throw new Error(`${type} is not supported in RPC parameters`);
  if (type === 'number' && !Number.isFinite(obj)) throw new Error('NaN and Infinity are not supported in RPC parameters');

  if (type !== 'object') return JSON.stringify(obj);

  if (Array.isArray(obj)) {
    return '[' + obj.map(item => canonicalJSON(item, depth + 1)).join(',') + ']';
  }

  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(key => JSON.stringify(key) + ':' + canonicalJSON(obj[key], depth + 1));
  return '{' + pairs.join(',') + '}';
}

/**
 * Build the message string for signing
 * Format: timestamp:nonce:method:canonicalJSON(params || {})
 * Uses colons as delimiters to prevent collision attacks
 * Includes nonce to prevent signature reuse within timestamp window
 * Uses canonical JSON (sorted keys) for deterministic serialization
 *
 * @param timestamp Unix timestamp in milliseconds
 * @param nonce Cryptographic nonce (UUID v4) to prevent replay attacks
 * @param method RPC method name
 * @param params RPC method parameters (optional)
 * @returns String to be signed
 */
export function buildSignatureMessage(timestamp: number, nonce: string, method: string, params?: any): string {
  // Validate nonce is UUID v4 format to prevent colon injection attacks
  // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx (8-4-4-4-12 hex digits with dashes)
  // Use simple format checks instead of regex to avoid any timing or ReDoS concerns

  // Check total length (36 characters for UUID v4)
  if (nonce.length !== 36) {
    throw new Error('Nonce must be a valid UUID v4 (use crypto.randomUUID())');
  }

  // Check dash positions (indices 8, 13, 18, 23)
  if (nonce[8] !== '-' || nonce[13] !== '-' || nonce[18] !== '-' || nonce[23] !== '-') {
    throw new Error('Nonce must be a valid UUID v4 (use crypto.randomUUID())');
  }

  // Check version (character at index 14 must be '4')
  if (nonce[14] !== '4') {
    throw new Error('Nonce must be a valid UUID v4 (use crypto.randomUUID())');
  }

  // Check variant (character at index 19 must be 8, 9, a, or b)
  const variant = nonce[19].toLowerCase();
  if (variant !== '8' && variant !== '9' && variant !== 'a' && variant !== 'b') {
    throw new Error('Nonce must be a valid UUID v4 (use crypto.randomUUID())');
  }

  // Validate all other characters are hex digits (0-9, a-f)
  const hexChars = nonce.replace(/-/g, ''); // Remove dashes
  for (let i = 0; i < hexChars.length; i++) {
    const c = hexChars[i].toLowerCase();
    if ((c < '0' || c > '9') && (c < 'a' || c > 'f')) {
      throw new Error('Nonce must be a valid UUID v4 (use crypto.randomUUID())');
    }
  }

  // Use canonical JSON (sorted keys) to match client's signature
  const paramsStr = canonicalJSON(params || {});
  // Use delimiters to prevent collision: timestamp=12,method="34" vs timestamp=1,method="234"
  // Include nonce to make each request unique (prevents signature reuse in same millisecond)
  return `${timestamp}:${nonce}:${method}:${paramsStr}`;
}

// ===== Username Validation =====

/**
 * Validates username format
 * Rules: 4-32 chars, lowercase alphanumeric + dashes + periods, must start/end with alphanumeric
 */
export function validateUsername(username: string): { valid: boolean; error?: string } {
  if (typeof username !== 'string') {
    return { valid: false, error: 'Username must be a string' };
  }

  if (username.length < USERNAME_MIN_LENGTH) {
    return { valid: false, error: `Username must be at least ${USERNAME_MIN_LENGTH} characters` };
  }

  if (username.length > USERNAME_MAX_LENGTH) {
    return { valid: false, error: `Username must be at most ${USERNAME_MAX_LENGTH} characters` };
  }

  if (!USERNAME_REGEX.test(username)) {
    return { valid: false, error: 'Username must be lowercase alphanumeric with optional dashes/periods, and start/end with alphanumeric' };
  }

  return { valid: true };
}

// ===== Tag Validation =====

// Tag validation constants
const TAG_MIN_LENGTH = 1;
const TAG_MAX_LENGTH = 64;
const TAG_REGEX = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Validates a single tag format
 * Rules: 1-64 chars, lowercase alphanumeric with optional dots/dashes
 * Must start and end with alphanumeric character
 *
 * Valid examples: "chat", "video-call", "com.example.service", "v2"
 * Invalid examples: "", "UPPERCASE", "-starts-dash", "ends-dash-"
 */
export function validateTag(tag: string): { valid: boolean; error?: string } {
  if (typeof tag !== 'string') {
    return { valid: false, error: 'Tag must be a string' };
  }

  if (tag.length < TAG_MIN_LENGTH) {
    return { valid: false, error: `Tag must be at least ${TAG_MIN_LENGTH} character` };
  }

  if (tag.length > TAG_MAX_LENGTH) {
    return { valid: false, error: `Tag must be at most ${TAG_MAX_LENGTH} characters` };
  }

  // Single character tags just need to be alphanumeric
  if (tag.length === 1) {
    if (!/^[a-z0-9]$/.test(tag)) {
      return { valid: false, error: 'Tag must be lowercase alphanumeric' };
    }
    return { valid: true };
  }

  // Multi-character tags must match the pattern
  if (!TAG_REGEX.test(tag)) {
    return { valid: false, error: 'Tag must be lowercase alphanumeric with optional dots/dashes, and start/end with alphanumeric' };
  }

  return { valid: true };
}

/**
 * Validates an array of tags
 * @param tags Array of tags to validate
 * @param maxTags Maximum number of tags allowed (default: 20)
 */
export function validateTags(tags: string[], maxTags: number = 20): { valid: boolean; error?: string } {
  if (!Array.isArray(tags)) {
    return { valid: false, error: 'Tags must be an array' };
  }

  if (tags.length === 0) {
    return { valid: false, error: 'At least one tag is required' };
  }

  if (tags.length > maxTags) {
    return { valid: false, error: `Maximum ${maxTags} tags allowed` };
  }

  // Validate each tag
  for (let i = 0; i < tags.length; i++) {
    const result = validateTag(tags[i]);
    if (!result.valid) {
      return { valid: false, error: `Tag ${i + 1}: ${result.error}` };
    }
  }

  // Check for duplicates
  const uniqueTags = new Set(tags);
  if (uniqueTags.size !== tags.length) {
    return { valid: false, error: 'Duplicate tags are not allowed' };
  }

  return { valid: true };
}
