/**
 * Generates a unique offer ID using SHA-256 hash
 * Combines SDP content with timestamp and random bytes for uniqueness
 * Uses Web Crypto API for compatibility with both Node.js and Cloudflare Workers
 *
 * @param sdp - The WebRTC SDP offer
 * @returns Unique SHA-256 hash ID
 */
export async function generateOfferHash(sdp: string): Promise<string> {
  // Generate random bytes for uniqueness (8 bytes = 64 bits of randomness)
  const randomBytes = crypto.getRandomValues(new Uint8Array(8));
  const randomHex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Include SDP, timestamp, and random bytes for uniqueness
  const hashInput = {
    sdp,
    timestamp: Date.now(),
    nonce: randomHex
  };

  // Create non-prettified JSON string
  const jsonString = JSON.stringify(hashInput);

  // Convert string to Uint8Array for hashing
  const encoder = new TextEncoder();
  const data = encoder.encode(jsonString);

  // Generate SHA-256 hash
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert hash to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return hashHex;
}
