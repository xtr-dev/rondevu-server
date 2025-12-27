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
 * Example: "brave-tiger-7a3f", "quick-river-9b2e"
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

  // Generate 4-character hex suffix for uniqueness
  const random = crypto.getRandomValues(new Uint8Array(2));
  const hex = Array.from(random).map(b => b.toString(16).padStart(2, '0')).join('');

  return `${adjective}-${noun}-${hex}`;
}

/**
 * Generates a random secret (API key style)
 * Format: 32-character hex string (128 bits of entropy)
 */
export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
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
