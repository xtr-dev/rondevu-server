/**
 * Generates a content-based offer ID using SHA-256 hash
 * Creates deterministic IDs based on offer SDP content
 * PeerID is not included as it's inferred from authentication
 * Uses Web Crypto API for compatibility with both Node.js and Cloudflare Workers
 *
 * @param sdp - The WebRTC SDP offer
 * @returns SHA-256 hash of the SDP content
 */
export async function generateOfferHash(sdp: string): Promise<string> {
  // Sanitize and normalize the offer content
  // Only include core offer content (not peerId - that's inferred from auth)
  const sanitizedOffer = {
    sdp
  };

  // Create non-prettified JSON string
  const jsonString = JSON.stringify(sanitizedOffer);

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
