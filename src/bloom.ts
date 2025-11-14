/**
 * Bloom filter utility for testing if peer IDs might be in a set
 * Used to filter out known peers from discovery results
 */

export class BloomFilter {
  private bits: Uint8Array;
  private size: number;
  private numHashes: number;

  /**
   * Creates a bloom filter from a base64 encoded bit array
   */
  constructor(base64Data: string, numHashes: number = 3) {
    // Decode base64 to buffer
    const buffer = Buffer.from(base64Data, 'base64');
    this.bits = new Uint8Array(buffer);
    this.size = this.bits.length * 8;
    this.numHashes = numHashes;
  }

  /**
   * Test if a peer ID might be in the filter
   * Returns true if possibly in set, false if definitely not in set
   */
  test(peerId: string): boolean {
    for (let i = 0; i < this.numHashes; i++) {
      const hash = this.hash(peerId, i);
      const index = hash % this.size;
      const byteIndex = Math.floor(index / 8);
      const bitIndex = index % 8;

      if (!(this.bits[byteIndex] & (1 << bitIndex))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Simple hash function (FNV-1a variant)
   */
  private hash(str: string, seed: number): number {
    let hash = 2166136261 ^ seed;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }
}

/**
 * Helper to parse bloom filter from base64 string
 */
export function parseBloomFilter(base64: string): BloomFilter | null {
  try {
    return new BloomFilter(base64);
  } catch {
    return null;
  }
}
