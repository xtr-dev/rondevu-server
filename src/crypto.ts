/**
 * Crypto utilities for credential generation and validation
 * Uses Web Crypto API for compatibility with both Node.js and Cloudflare Workers
 */

import { Buffer } from 'node:buffer';

// Username validation (used for service FQN parsing)
const USERNAME_REGEX = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const USERNAME_MIN_LENGTH = 3;
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

  // Generate 12-character hex suffix for uniqueness (6 bytes = 2^48 combinations)
  // With 576 adjective-noun pairs, total space: 576 × 2^48 ≈ 162 quadrillion names
  // Birthday paradox collision at ~10.6 million credentials (safe for large deployments)
  // Increased from 4 bytes to 6 bytes for better collision resistance
  const random = crypto.getRandomValues(new Uint8Array(6));
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

  // Validation: Ensure output is exactly 64 characters
  if (secret.length !== 64) {
    throw new Error('Secret generation failed: invalid length');
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
 * Uses timing-safe comparison to prevent timing attacks
 *
 * @param secret The credential secret (hex string)
 * @param message The message that was signed
 * @param signature The signature to verify (base64)
 * @returns Promise<boolean> True if signature is valid
 */
export async function verifySignature(secret: string, message: string, signature: string): Promise<boolean> {
  try {
    // Generate expected signature
    const expectedSignature = await generateSignature(secret, message);

    // Timing-safe comparison (includes length check to prevent timing side-channel)
    // XOR length difference into result to include length in constant-time comparison
    let result = expectedSignature.length ^ signature.length;

    // Compare all bytes up to the minimum length (constant-time for equal lengths)
    const minLength = Math.min(expectedSignature.length, signature.length);
    for (let i = 0; i < minLength; i++) {
      result |= expectedSignature.charCodeAt(i) ^ signature.charCodeAt(i);
    }

    return result === 0;
  } catch (error) {
    // Log error for debugging (helps identify implementation bugs)
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Build the message string for signing
 * Format: timestamp:nonce:method:JSON.stringify(params || {})
 * Uses colons as delimiters to prevent collision attacks
 * Includes nonce to prevent signature reuse within timestamp window
 *
 * @param timestamp Unix timestamp in milliseconds
 * @param nonce Cryptographic nonce (UUID v4) to prevent replay attacks
 * @param method RPC method name
 * @param params RPC method parameters (optional)
 * @returns String to be signed
 */
export function buildSignatureMessage(timestamp: number, nonce: string, method: string, params?: any): string {
  const paramsStr = params ? JSON.stringify(params) : '{}';
  // Use delimiters to prevent collision: timestamp=12,method="34" vs timestamp=1,method="234"
  // Include nonce to make each request unique (prevents signature reuse in same millisecond)
  return `${timestamp}:${nonce}:${method}:${paramsStr}`;
}

/**
 * Generates an anonymous username for users who don't want to claim one
 * Format: anon-{timestamp}-{random}
 * This reduces collision probability to near-zero
 * @deprecated Use generateCredentialName() instead
 */
export function generateAnonymousUsername(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.getRandomValues(new Uint8Array(3));
  const hex = Array.from(random).map(b => b.toString(16).padStart(2, '0')).join('');
  return `anon-${timestamp}-${hex}`;
}

// ===== Username Validation =====

/**
 * Validates username format (used for service FQN parsing)
 * Rules: 3-32 chars, lowercase alphanumeric + dash, must start/end with alphanumeric
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
    return { valid: false, error: 'Username must be lowercase alphanumeric with optional dashes, and start/end with alphanumeric' };
  }

  return { valid: true };
}

/**
 * Validates service FQN format (service:version@username or service:version)
 * Service name: lowercase alphanumeric with dots/dashes (e.g., chat, file-share, com.example.chat)
 * Version: semantic versioning (1.0.0, 2.1.3-beta, etc.)
 * Username: optional, lowercase alphanumeric with dashes
 */
export function validateServiceFqn(fqn: string): { valid: boolean; error?: string } {
  if (typeof fqn !== 'string') {
    return { valid: false, error: 'Service FQN must be a string' };
  }

  // Parse the FQN
  const parsed = parseServiceFqn(fqn);
  if (!parsed) {
    return { valid: false, error: 'Service FQN must be in format: service:version[@username]' };
  }

  const { serviceName, version, username } = parsed;

  // Validate service name (alphanumeric with dots/dashes)
  const serviceNameRegex = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
  if (!serviceNameRegex.test(serviceName)) {
    return { valid: false, error: 'Service name must be lowercase alphanumeric with optional dots/dashes' };
  }

  if (serviceName.length < 1 || serviceName.length > 128) {
    return { valid: false, error: 'Service name must be 1-128 characters' };
  }

  // Validate version (semantic versioning)
  const versionRegex = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$/;
  if (!versionRegex.test(version)) {
    return { valid: false, error: 'Version must be semantic versioning (e.g., 1.0.0, 2.1.3-beta)' };
  }

  // Validate username if present
  if (username) {
    const usernameCheck = validateUsername(username);
    if (!usernameCheck.valid) {
      return usernameCheck;
    }
  }

  return { valid: true };
}

/**
 * Parse semantic version string into components
 */
export function parseVersion(version: string): { major: number; minor: number; patch: number; prerelease?: string } | null {
  const match = version.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)(-[a-z0-9.-]+)?$/);
  if (!match) return null;

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4]?.substring(1), // Remove leading dash
  };
}

/**
 * Check if two versions are compatible (same major version)
 * Following semver rules: ^1.0.0 matches 1.x.x but not 2.x.x
 */
export function isVersionCompatible(requested: string, available: string): boolean {
  const req = parseVersion(requested);
  const avail = parseVersion(available);

  if (!req || !avail) return false;

  // Major version must match
  if (req.major !== avail.major) return false;

  // If major is 0, minor must also match (0.x.y is unstable)
  if (req.major === 0 && req.minor !== avail.minor) return false;

  // Available version must be >= requested version
  if (avail.minor < req.minor) return false;
  if (avail.minor === req.minor && avail.patch < req.patch) return false;

  // Prerelease versions are only compatible with exact matches
  if (req.prerelease && req.prerelease !== avail.prerelease) return false;

  return true;
}

/**
 * Parse service FQN into components
 * Formats supported:
 * - service:version@username (e.g., "chat:1.0.0@alice")
 * - service:version (e.g., "chat:1.0.0") for discovery
 */
export function parseServiceFqn(fqn: string): { serviceName: string; version: string; username: string | null } | null {
  if (!fqn || typeof fqn !== 'string') return null;

  // Check if username is present
  const atIndex = fqn.lastIndexOf('@');
  let serviceVersion: string;
  let username: string | null = null;

  if (atIndex > 0) {
    // Format: service:version@username
    serviceVersion = fqn.substring(0, atIndex);
    username = fqn.substring(atIndex + 1);
  } else {
    // Format: service:version (no username)
    serviceVersion = fqn;
  }

  // Split service:version
  const colonIndex = serviceVersion.indexOf(':');
  if (colonIndex <= 0) return null; // No colon or colon at start

  const serviceName = serviceVersion.substring(0, colonIndex);
  const version = serviceVersion.substring(colonIndex + 1);

  if (!serviceName || !version) return null;

  return {
    serviceName,
    version,
    username,
  };
}
