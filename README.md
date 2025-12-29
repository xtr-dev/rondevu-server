# Rondevu Server

[![npm version](https://img.shields.io/npm/v/@xtr-dev/rondevu-server)](https://www.npmjs.com/package/@xtr-dev/rondevu-server)

🌐 **Simple WebRTC signaling with RPC interface**

Scalable WebRTC signaling server with cryptographic username claiming, service publishing with semantic versioning, and efficient offer/answer exchange via JSON-RPC interface.

**Related repositories:**
- [@xtr-dev/rondevu-client](https://github.com/xtr-dev/rondevu-client) - TypeScript client library ([npm](https://www.npmjs.com/package/@xtr-dev/rondevu-client))
- [@xtr-dev/rondevu-server](https://github.com/xtr-dev/rondevu-server) - HTTP signaling server ([npm](https://www.npmjs.com/package/@xtr-dev/rondevu-server), [live](https://api.ronde.vu))
- [@xtr-dev/rondevu-demo](https://github.com/xtr-dev/rondevu-demo) - Interactive demo ([live](https://ronde.vu))

---

## Features

- **RPC Interface**: Single endpoint for all operations with batching support
- **Credential-Based Authentication**: HMAC-SHA256 signature authentication with named credentials (365-day validity, auto-renewed on use)
- **Offer Publishing**: Service:version@name naming (e.g., `chat:1.0.0@alice`)
- **Offer Discovery**: Random and paginated discovery for finding offers without knowing credential names
- **Semantic Versioning**: Compatible version matching (chat:1.0.0 matches any 1.x.x)
- **HMAC Signatures**: All authenticated requests use HMAC-SHA256 signatures with nonce-based replay protection
- **Complete WebRTC Signaling**: Offer/answer exchange and ICE candidate relay
- **Batch Operations**: Execute multiple operations in a single HTTP request
- **Dual Storage**: SQLite (Node.js/Docker) and Cloudflare D1 (Workers) backends with AES-256-GCM secret encryption

## Architecture

```
Credential Generation → Offer Publishing → Offer Discovery → WebRTC Connection

alice generates credentials (friendly-panda-a1b2c3d4e5f6 + secret)
  ↓
alice publishes chat:1.0.0@friendly-panda-a1b2c3d4e5f6 with HMAC signature
  ↓
bob queries chat:1.0.0 (discovery) or direct → gets offer SDP
  ↓
bob posts answer SDP with HMAC signature → WebRTC connection established
  ↓
ICE candidates exchanged via server relay with HMAC authentication
```

## Quick Start

**Node.js:**
```bash
npm install && npm start
```

**Docker:**
```bash
docker build -t rondevu . && docker run -p 3000:3000 -e STORAGE_PATH=:memory: rondevu
```

**Cloudflare Workers:**
```bash
npx wrangler deploy
```

## RPC Interface

All API calls are made to `POST /rpc` with JSON-RPC format.

**Important:** The API only accepts batch requests (arrays). All requests must be wrapped in an array, even for single operations.

### Request Format

**Request (must be an array):**
```json
[
  {
    "method": "getUser",
    "params": { "username": "alice" }
  },
  {
    "method": "getOffer",
    "params": { "serviceFqn": "chat:1.0.0" }
  }
]
```

**Single operation (still requires array):**
```json
[
  {
    "method": "getUser",
    "params": { "username": "alice" }
  }
]
```

**Note:** Batch requests are limited to 100 operations by default (configurable via `MAX_BATCH_SIZE` environment variable).

**Authentication headers (for authenticated methods):**
- `X-Name`: Your credential name
- `X-Timestamp`: Current timestamp (milliseconds)
- `X-Nonce`: Cryptographic nonce (use `crypto.randomUUID()`)
- `X-Signature`: HMAC-SHA256 signature (base64-encoded)

### Response Format

**Responses (always an array):**
```json
[
  {
    "success": true,
    "result": { /* method-specific data */ }
  },
  {
    "success": false,
    "error": "Error message",
    "errorCode": "OFFER_NOT_FOUND"
  }
]
```

Responses are returned in the same order as requests.

**Error Codes:**
All error responses include an `errorCode` field for programmatic error handling:
- `AUTH_REQUIRED`, `INVALID_CREDENTIALS`
- `INVALID_NAME`, `INVALID_FQN`, `INVALID_SDP`, `INVALID_PARAMS`, `MISSING_PARAMS`
- `OFFER_NOT_FOUND`, `OFFER_ALREADY_ANSWERED`, `OFFER_NOT_ANSWERED`, `NO_AVAILABLE_OFFERS`
- `NOT_AUTHORIZED`, `OWNERSHIP_MISMATCH`
- `TOO_MANY_OFFERS`, `SDP_TOO_LARGE`, `BATCH_TOO_LARGE`, `RATE_LIMIT_EXCEEDED`
- `INTERNAL_ERROR`, `UNKNOWN_METHOD`

## Core Methods

### Credential Management

```typescript
// Generate new credentials (no authentication required)
POST /rpc
[
  {
    "method": "generateCredentials",
    "params": {
      "expiresAt": 1735363200000  // Optional: Unix timestamp in ms (default: 365 days)
    }
  }
]

// Response:
{
  "success": true,
  "result": {
    "name": "friendly-panda-a1b2c3d4e5f6",
    "secret": "5a7f3e8c9d2b1a4e6f8c0d9e2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b",
    "createdAt": 1704067200000,
    "expiresAt": 1735603200000
  }
}

// IMPORTANT: Save the secret securely - it will never be shown again!
```

### Offer Publishing

```typescript
// Publish offer (requires authentication)
POST /rpc
Headers:
  X-Name: friendly-panda-a1b2c3d4e5f6
  X-Timestamp: 1704067200000
  X-Nonce: 550e8400-e29b-41d4-a716-446655440000
  X-Signature: <base64-hmac-sha256-signature>
[
  {
    "method": "publishOffer",
    "params": {
      "serviceFqn": "chat:1.0.0@friendly-panda-a1b2c3d4e5f6",
      "offers": [{ "sdp": "webrtc-offer-sdp" }],
      "ttl": 300000
    }
  }
]
```

### Offer Discovery

```typescript
// Get specific offer
POST /rpc
[
  {
    "method": "getOffer",
    "params": { "serviceFqn": "chat:1.0.0@alice" }
  }
]

// Random discovery
POST /rpc
[
  {
    "method": "getOffer",
    "params": { "serviceFqn": "chat:1.0.0" }
  }
]

// Paginated discovery
POST /rpc
[
  {
    "method": "getOffer",
    "params": {
      "serviceFqn": "chat:1.0.0",
      "limit": 10,
      "offset": 0
    }
  }
]
```

### WebRTC Signaling

```typescript
// Answer offer (requires authentication)
POST /rpc
Headers:
  X-Name: gentle-turtle-b2c3d4e5f6a1
  X-Timestamp: 1704067200000
  X-Nonce: 660e8400-e29b-41d4-a716-446655440001
  X-Signature: <base64-hmac-sha256-signature>
[
  {
    "method": "answerOffer",
    "params": {
      "serviceFqn": "chat:1.0.0@friendly-panda-a1b2c3d4e5f6",
      "offerId": "offer-id",
      "sdp": "webrtc-answer-sdp"
    }
  }
]

// Add ICE candidates (requires authentication)
POST /rpc
Headers:
  X-Name: friendly-panda-a1b2c3d4e5f6
  X-Timestamp: 1704067300000
  X-Nonce: 770e8400-e29b-41d4-a716-446655440002
  X-Signature: <base64-hmac-sha256-signature>
[
  {
    "method": "addIceCandidates",
    "params": {
      "serviceFqn": "chat:1.0.0@friendly-panda-a1b2c3d4e5f6",
      "offerId": "offer-id",
      "candidates": [{ /* RTCIceCandidateInit */ }]
    }
  }
]

// Poll for answers and ICE candidates (requires authentication)
POST /rpc
Headers:
  X-Name: friendly-panda-a1b2c3d4e5f6
  X-Timestamp: 1704067400000
  X-Nonce: 880e8400-e29b-41d4-a716-446655440003
  X-Signature: <base64-hmac-sha256-signature>
[
  {
    "method": "poll",
    "params": { "since": 1733404800000 }
  }
]
```

## Configuration

Quick reference for common environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port (Node.js/Docker) |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `STORAGE_PATH` | `./rondevu.db` | SQLite database path (use `:memory:` for in-memory) |
| `MAX_BATCH_SIZE` | `100` | Maximum number of requests per batch |
| `MASTER_ENCRYPTION_KEY` | (dev key) | 64-char hex string for encrypting secrets (generate with `openssl rand -hex 32`) |
| `TIMESTAMP_MAX_AGE` | `60000` | Maximum timestamp age in milliseconds for replay protection |

## Security

All authenticated operations require HMAC-SHA256 signatures:
- **Credential Generation**: Generate credentials via `generateCredentials` method (returns name + secret)
- **Message Format**: `timestamp:nonce:method:JSON.stringify(params)`
- **Signature**: Base64-encoded HMAC-SHA256 signature using credential secret
- **Replay Protection**: Timestamps must be within 60 seconds + unique nonce per request
- **Secret Storage**: Secrets encrypted with AES-256-GCM using master encryption key
- **Rate Limiting**: IP-based rate limiting on credential generation (10/hour)

## Changelog

### v0.5.4 (Latest)
- Add expiresAt validation in generateCredentials (prevent past/invalid timestamps)
- Add TTL validation in publishOffer (prevent NaN database corruption)
- Fix config validation bypass vulnerability (enforce minimum values, fail on NaN)

### v0.5.3
- Fix RPC method calls using non-existent storage methods
- Replace `storage.getServicesByName()` with `storage.discoverServices()` and `storage.getRandomService()`
- Ensures compatibility with Storage interface specification

## License

MIT
