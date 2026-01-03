/**
 * Integration test setup and helpers for api.ronde.vu
 * Implements HMAC-SHA256 authentication directly (not dependent on client library)
 */

import { Buffer } from 'node:buffer'
import * as crypto from 'node:crypto'

const API_URL = process.env.API_URL || 'https://api.ronde.vu'

export interface Credential {
    name: string
    secret: string
}

/**
 * Convert hex string to bytes
 */
function hexToBytes(hex: string): Uint8Array {
    const match = hex.match(/.{1,2}/g)
    if (!match) throw new Error('Invalid hex string')
    return new Uint8Array(match.map(byte => parseInt(byte, 16)))
}

/**
 * Generate HMAC-SHA256 signature
 */
async function generateSignature(secret: string, message: string): Promise<string> {
    const secretBytes = hexToBytes(secret)
    const key = await globalThis.crypto.subtle.importKey(
        'raw',
        secretBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    )
    const encoder = new TextEncoder()
    const messageBytes = encoder.encode(message)
    const signatureBytes = await globalThis.crypto.subtle.sign('HMAC', key, messageBytes)
    return Buffer.from(signatureBytes).toString('base64')
}

/**
 * Build auth headers for authenticated RPC calls
 */
async function buildAuthHeaders(
    credential: Credential,
    method: string,
    params: any
): Promise<Record<string, string>> {
    const timestamp = Date.now()
    const nonce = crypto.randomUUID()
    const paramsStr = params ? JSON.stringify(params) : '{}'
    const message = `${timestamp}:${nonce}:${method}:${paramsStr}`
    const signature = await generateSignature(credential.secret, message)

    return {
        'X-Name': credential.name,
        'X-Timestamp': timestamp.toString(),
        'X-Nonce': nonce,
        'X-Signature': signature
    }
}

/**
 * Make an RPC call to the API (authenticated or unauthenticated)
 */
export async function rpc<T = any>(
    method: string,
    params: any,
    credential?: Credential
): Promise<T> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json'
    }

    // Add auth headers if credential provided
    if (credential) {
        const authHeaders = await buildAuthHeaders(credential, method, params)
        Object.assign(headers, authHeaders)
    }

    const body = JSON.stringify([{ method, params }])

    const response = await fetch(`${API_URL}/rpc`, {
        method: 'POST',
        headers,
        body
    })

    const results = await response.json() as Array<{ success: boolean; result?: T; error?: string; errorCode?: string }>

    if (!Array.isArray(results) || results.length === 0) {
        throw new Error('Invalid response from API')
    }

    const res = results[0]

    if (!res.success || res.error) {
        throw new Error(`RPC Error: ${res.error || 'Unknown error'} (${res.errorCode || 'UNKNOWN'})`)
    }

    return res.result as T
}

/**
 * Generate new credentials from the API
 */
export async function generateCredentials(): Promise<Credential> {
    const result = await rpc<{ name: string; secret: string }>('generateCredentials', {})
    return result
}

/**
 * Simple authenticated API wrapper for tests
 */
class TestAPI {
    constructor(private credential: Credential) {}

    async publish(params: { tags: string[], offers: { sdp: string }[], ttl: number }) {
        return rpc('publishOffer', params, this.credential)
    }

    async discover(params: { tags: string[], limit?: number, offset?: number }) {
        return rpc('discover', params, this.credential)
    }

    async answerOffer(offerId: string, sdp: string) {
        return rpc('answerOffer', { offerId, sdp }, this.credential)
    }

    async addOfferIceCandidates(offerId: string, candidates: any[]) {
        return rpc('addIceCandidates', { offerId, candidates }, this.credential)
    }

    async getOfferIceCandidates(offerId: string, since: number) {
        return rpc('getIceCandidates', { offerId, since }, this.credential)
    }

    async poll(since: number) {
        return rpc('poll', { since }, this.credential)
    }

    async deleteOffer(offerId: string) {
        return rpc('deleteOffer', { offerId }, this.credential)
    }
}

/**
 * Create a test context with fresh credentials and API wrapper
 */
export async function createTestContext() {
    const credential = await generateCredentials()
    const api = new TestAPI(credential)

    return {
        credential,
        api,
        apiUrl: API_URL
    }
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export { API_URL }
