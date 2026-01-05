/**
 * Crypto utilities for Ed25519 signature verification and validation
 * Uses @noble/ed25519 for Ed25519 operations and Web Crypto API for SHA-512
 */

import { Buffer } from 'node:buffer';
import * as ed from '@noble/ed25519';

// Configure @noble/ed25519 to use Web Crypto API's SHA-512
// Required for both Node.js and Cloudflare Workers compatibility
ed.hashes.sha512Async = async (message: Uint8Array): Promise<Uint8Array> => {
  const hashBuffer = await crypto.subtle.digest('SHA-512', message);
  return new Uint8Array(hashBuffer);
};

/**
 * Convert hex string to byte array with validation
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have even length');
  }

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
 * Canonical JSON serialization with sorted keys.
 * Ensures deterministic output regardless of property insertion order.
 * Must match client's canonicalJSON implementation exactly.
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
 * Build the message string for signing.
 * Format: timestamp:nonce:method:canonicalJSON(params || {})
 */
export function buildSignatureMessage(timestamp: number, nonce: string, method: string, params?: any): string {
  // Validate nonce is UUID v4 format
  if (nonce.length !== 36) {
    throw new Error('Nonce must be a valid UUID v4 (use crypto.randomUUID())');
  }

  if (nonce[8] !== '-' || nonce[13] !== '-' || nonce[18] !== '-' || nonce[23] !== '-') {
    throw new Error('Nonce must be a valid UUID v4 (use crypto.randomUUID())');
  }

  if (nonce[14] !== '4') {
    throw new Error('Nonce must be a valid UUID v4 (use crypto.randomUUID())');
  }

  const variant = nonce[19].toLowerCase();
  if (variant !== '8' && variant !== '9' && variant !== 'a' && variant !== 'b') {
    throw new Error('Nonce must be a valid UUID v4 (use crypto.randomUUID())');
  }

  const hexChars = nonce.replace(/-/g, '');
  for (let i = 0; i < hexChars.length; i++) {
    const c = hexChars[i].toLowerCase();
    if ((c < '0' || c > '9') && (c < 'a' || c > 'f')) {
      throw new Error('Nonce must be a valid UUID v4 (use crypto.randomUUID())');
    }
  }

  const paramsStr = canonicalJSON(params || {});
  return `${timestamp}:${nonce}:${method}:${paramsStr}`;
}

// ===== Ed25519 Public Key Identity =====

const ED25519_PUBLIC_KEY_LENGTH = 32; // 32 bytes = 64 hex chars
const ED25519_SIGNATURE_LENGTH = 64;  // 64 bytes

/**
 * Validates an Ed25519 public key format.
 * @param publicKey 64-character lowercase hex string (32 bytes)
 */
export function validatePublicKey(publicKey: string): { valid: boolean; error?: string } {
  if (typeof publicKey !== 'string') {
    return { valid: false, error: 'Public key must be a string' };
  }

  if (publicKey.length !== ED25519_PUBLIC_KEY_LENGTH * 2) {
    return { valid: false, error: `Public key must be ${ED25519_PUBLIC_KEY_LENGTH * 2} hex characters (${ED25519_PUBLIC_KEY_LENGTH} bytes)` };
  }

  for (let i = 0; i < publicKey.length; i++) {
    const c = publicKey[i];
    if ((c < '0' || c > '9') && (c < 'a' || c > 'f')) {
      return { valid: false, error: `Invalid hex character at position ${i}: '${c}' (use lowercase hex)` };
    }
  }

  return { valid: true };
}

/**
 * Verify an Ed25519 signature.
 * @param publicKey Signer's public key (64-char hex)
 * @param message Message that was signed
 * @param signature Signature to verify (base64 encoded)
 */
export async function verifyEd25519Signature(
  publicKey: string,
  message: string,
  signature: string
): Promise<boolean> {
  try {
    const pkValidation = validatePublicKey(publicKey);
    if (!pkValidation.valid) {
      console.error('Ed25519 verification error: invalid public key:', pkValidation.error);
      return false;
    }

    const publicKeyBytes = hexToBytes(publicKey);
    const encoder = new TextEncoder();
    const messageBytes = encoder.encode(message);
    const signatureBytes = Buffer.from(signature, 'base64');

    if (signatureBytes.length !== ED25519_SIGNATURE_LENGTH) {
      console.error(`Ed25519 verification error: signature length ${signatureBytes.length}, expected ${ED25519_SIGNATURE_LENGTH}`);
      return false;
    }

    return await ed.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
  } catch (error) {
    console.error('Ed25519 verification error:', error);
    return false;
  }
}

// ===== Tag Validation =====

const TAG_MIN_LENGTH = 1;
const TAG_MAX_LENGTH = 64;
const TAG_REGEX = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Validates a single tag format.
 * Rules: 1-64 chars, lowercase alphanumeric with optional dots/dashes,
 * must start and end with alphanumeric character.
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

  if (tag.length === 1) {
    if (!/^[a-z0-9]$/.test(tag)) {
      return { valid: false, error: 'Tag must be lowercase alphanumeric' };
    }
    return { valid: true };
  }

  if (!TAG_REGEX.test(tag)) {
    return { valid: false, error: 'Tag must be lowercase alphanumeric with optional dots/dashes, and start/end with alphanumeric' };
  }

  return { valid: true };
}

/**
 * Validates an array of tags.
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

  for (let i = 0; i < tags.length; i++) {
    const result = validateTag(tags[i]);
    if (!result.valid) {
      return { valid: false, error: `Tag ${i + 1}: ${result.error}` };
    }
  }

  const uniqueTags = new Set(tags);
  if (uniqueTags.size !== tags.length) {
    return { valid: false, error: 'Duplicate tags are not allowed' };
  }

  return { valid: true };
}
