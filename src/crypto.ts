/**
 * Crypto utilities for Ed25519-based authentication
 * Uses @noble/ed25519 for Ed25519 signature verification
 * Uses Web Crypto API for compatibility with both Node.js and Cloudflare Workers
 */

import * as ed25519 from '@noble/ed25519';
import { Buffer } from 'node:buffer';

// Set SHA-512 hash function for ed25519 (required in @noble/ed25519 v3+)
// Uses Web Crypto API (compatible with both Node.js and Cloudflare Workers)
ed25519.hashes.sha512Async = async (message: Uint8Array) => {
  return new Uint8Array(await crypto.subtle.digest('SHA-512', message as BufferSource));
};

// Username validation
const USERNAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 32;

// Timestamp validation (5 minutes tolerance)
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Generates an anonymous username for users who don't want to claim one
 * Format: anon-{timestamp}-{random}
 * This reduces collision probability to near-zero
 */
export function generateAnonymousUsername(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.getRandomValues(new Uint8Array(3));
  const hex = Array.from(random).map(b => b.toString(16).padStart(2, '0')).join('');
  return `anon-${timestamp}-${hex}`;
}

/**
 * Convert Uint8Array to base64 string
 * Uses Buffer for compatibility with Node.js-based clients
 */
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Convert base64 string to Uint8Array
 * Uses Buffer for compatibility with Node.js-based clients
 */
function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Validates a generic auth message format
 * Expected format: action:username:params:timestamp
 * Validates that the message contains the expected username and has a valid timestamp
 */
export function validateAuthMessage(
  expectedUsername: string,
  message: string
): { valid: boolean; error?: string } {
  const parts = message.split(':');

  if (parts.length < 3) {
    return { valid: false, error: 'Invalid message format: must have at least action:username:timestamp' };
  }

  // Extract username (second part) and timestamp (last part)
  const messageUsername = parts[1];
  const timestamp = parseInt(parts[parts.length - 1], 10);

  // Validate username matches
  if (messageUsername !== expectedUsername) {
    return { valid: false, error: 'Username in message does not match authenticated username' };
  }

  // Validate timestamp
  if (isNaN(timestamp)) {
    return { valid: false, error: 'Invalid timestamp in message' };
  }

  const timestampCheck = validateTimestamp(timestamp);
  if (!timestampCheck.valid) {
    return timestampCheck;
  }

  return { valid: true };
}

// ===== Username and Ed25519 Signature Utilities =====

/**
 * Validates username format
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

/**
 * Validates timestamp is within acceptable range (prevents replay attacks)
 */
export function validateTimestamp(timestamp: number): { valid: boolean; error?: string } {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return { valid: false, error: 'Timestamp must be a finite number' };
  }

  const now = Date.now();
  const diff = Math.abs(now - timestamp);

  if (diff > TIMESTAMP_TOLERANCE_MS) {
    return { valid: false, error: `Timestamp too old or too far in future (tolerance: ${TIMESTAMP_TOLERANCE_MS / 1000}s)` };
  }

  return { valid: true };
}

/**
 * Verifies Ed25519 signature
 * @param publicKey Base64-encoded Ed25519 public key (32 bytes)
 * @param signature Base64-encoded Ed25519 signature (64 bytes)
 * @param message Message that was signed (UTF-8 string)
 * @returns true if signature is valid, false otherwise
 */
export async function verifyEd25519Signature(
  publicKey: string,
  signature: string,
  message: string
): Promise<boolean> {
  try {
    // Decode base64 to bytes
    const publicKeyBytes = base64ToBytes(publicKey);
    const signatureBytes = base64ToBytes(signature);

    // Encode message as UTF-8
    const encoder = new TextEncoder();
    const messageBytes = encoder.encode(message);

    // Verify signature using @noble/ed25519 (async version)
    const isValid = await ed25519.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
    return isValid;
  } catch (err) {
    console.error('Ed25519 signature verification failed:', err);
    return false;
  }
}

/**
 * Validates a username claim request
 * Verifies format, timestamp, and signature
 */
export async function validateUsernameClaim(
  username: string,
  publicKey: string,
  signature: string,
  message: string
): Promise<{ valid: boolean; error?: string }> {
  // Validate username format
  const usernameCheck = validateUsername(username);
  if (!usernameCheck.valid) {
    return usernameCheck;
  }

  // Parse message format: "claim:{username}:{timestamp}"
  const parts = message.split(':');
  if (parts.length !== 3 || parts[0] !== 'claim' || parts[1] !== username) {
    return { valid: false, error: 'Invalid message format (expected: claim:{username}:{timestamp})' };
  }

  const timestamp = parseInt(parts[2], 10);
  if (isNaN(timestamp)) {
    return { valid: false, error: 'Invalid timestamp in message' };
  }

  // Validate timestamp
  const timestampCheck = validateTimestamp(timestamp);
  if (!timestampCheck.valid) {
    return timestampCheck;
  }

  // Verify signature
  const signatureValid = await verifyEd25519Signature(publicKey, signature, message);
  if (!signatureValid) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true };
}

/**
 * Validates a service publish signature
 * Message format: publish:{username}:{serviceFqn}:{timestamp}
 */
export async function validateServicePublish(
  username: string,
  serviceFqn: string,
  publicKey: string,
  signature: string,
  message: string
): Promise<{ valid: boolean; error?: string }> {
  // Validate username format
  const usernameCheck = validateUsername(username);
  if (!usernameCheck.valid) {
    return usernameCheck;
  }

  // Parse message format: "publish:{username}:{serviceFqn}:{timestamp}"
  // Note: serviceFqn can contain colons (e.g., "chat:2.0.0@user"), so we need careful parsing
  const parts = message.split(':');
  if (parts.length < 4 || parts[0] !== 'publish' || parts[1] !== username) {
    return { valid: false, error: 'Invalid message format (expected: publish:{username}:{serviceFqn}:{timestamp})' };
  }

  // The timestamp is the last part
  const timestamp = parseInt(parts[parts.length - 1], 10);
  if (isNaN(timestamp)) {
    return { valid: false, error: 'Invalid timestamp in message' };
  }

  // The serviceFqn is everything between username and timestamp
  const extractedServiceFqn = parts.slice(2, parts.length - 1).join(':');
  if (extractedServiceFqn !== serviceFqn) {
    return { valid: false, error: `Service FQN mismatch (expected: ${serviceFqn}, got: ${extractedServiceFqn})` };
  }

  // Validate timestamp
  const timestampCheck = validateTimestamp(timestamp);
  if (!timestampCheck.valid) {
    return timestampCheck;
  }

  // Verify signature
  const signatureValid = await verifyEd25519Signature(publicKey, signature, message);
  if (!signatureValid) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true };
}
