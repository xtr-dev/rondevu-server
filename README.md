# Rondevu Server

[![npm version](https://img.shields.io/npm/v/@xtr-dev/rondevu-server)](https://www.npmjs.com/package/@xtr-dev/rondevu-server)

**Simple WebRTC signaling with tags-based discovery**

Scalable WebRTC signaling server with credential-based authentication, tag-based offer discovery, and efficient offer/answer exchange via JSON-RPC interface.

**Related repositories:**
- [@xtr-dev/rondevu-client](https://github.com/xtr-dev/rondevu-client) - TypeScript client library ([npm](https://www.npmjs.com/package/@xtr-dev/rondevu-client))
- [@xtr-dev/rondevu-server](https://github.com/xtr-dev/rondevu-server) - HTTP signaling server ([npm](https://www.npmjs.com/package/@xtr-dev/rondevu-server), [live](https://api.ronde.vu))
- [@xtr-dev/rondevu-demo](https://github.com/xtr-dev/rondevu-demo) - Interactive demo ([live](https://ronde.vu))

---

## Features

- **RPC Interface**: Single endpoint for all operations with batching support
- **Credential-Based Authentication**: HMAC-SHA256 signature authentication with named credentials (365-day validity, auto-renewed on use)
- **Tag-Based Discovery**: Offers are categorized with tags (e.g., `["chat", "video"]`) for flexible discovery
- **OR-Based Matching**: Discovery matches offers with ANY of the requested tags
- **HMAC Signatures**: All authenticated requests use HMAC-SHA256 signatures with nonce-based replay protection
- **Complete WebRTC Signaling**: Offer/answer exchange and ICE candidate relay
- **Batch Operations**: Execute multiple operations in a single HTTP request
- **Dual Storage**: SQLite (Node.js/Docker) and Cloudflare D1 (Workers) backends with AES-256-GCM secret encryption

## Architecture

```
Credential Generation → Offer Publishing → Offer Discovery → WebRTC Connection

alice generates credentials (friendly-panda-a1b2c3d4 + secret)
  ↓
alice publishes offer with tags: ["chat", "video"] + HMAC signature
  ↓
bob discovers offers with tags: ["chat"] → gets alice's offer SDP
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
    "method": "discover",
    "params": { "tags": ["chat"], "limit": 10 }
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
- `AUTH_REQUIRED`, `INVALID_CREDENTIALS`
- `INVALID_TAG`, `INVALID_SDP`, `INVALID_PARAMS`, `MISSING_PARAMS`
- `OFFER_NOT_FOUND`, `OFFER_ALREADY_ANSWERED`, `OFFER_NOT_ANSWERED`
- `NOT_AUTHORIZED`, `OWNERSHIP_MISMATCH`
- `TOO_MANY_OFFERS`, `SDP_TOO_LARGE`, `BATCH_TOO_LARGE`, `RATE_LIMIT_EXCEEDED`
- `INTERNAL_ERROR`, `UNKNOWN_METHOD`

## Core Methods

### Credential Management

```typescript
// Generate new credentials with auto-generated username
POST /rpc
[
  {
    "method": "generateCredentials",
    "params": {}
  }
]

// Or claim a custom username (4-32 chars, lowercase alphanumeric + dashes + periods)
POST /rpc
[
  {
    "method": "generateCredentials",
    "params": { "name": "alice" }
  }
]

// Response:
{
  "success": true,
  "result": {
    "name": "alice",
    "secret": "5a7f3e8c9d2b1a4e6f8c0d9e2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b",
    "createdAt": 1704067200000,
    "expiresAt": 1735603200000
  }
}

// Error if username already taken:
{ "success": false, "error": "Username already taken" }

// IMPORTANT: Save the secret securely - it will never be shown again!
```

### Offer Publishing

```typescript
// Publish offer with tags (requires authentication)
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
      "tags": ["chat", "video"],
      "offers": [{ "sdp": "webrtc-offer-sdp" }],
      "ttl": 300000
    }
  }
]

// Response:
{
  "success": true,
  "result": {
    "offers": [
      {
        "offerId": "abc123...",
        "tags": ["chat", "video"],
        "sdp": "webrtc-offer-sdp",
        "createdAt": 1704067200000,
        "expiresAt": 1704067500000
      }
    ]
  }
}
```

### Offer Discovery

```typescript
// Discover offers by tags (paginated mode - no auth required)
POST /rpc
[
  {
    "method": "discover",
    "params": {
      "tags": ["chat"],
      "limit": 10,
      "offset": 0
    }
  }
]

// Response:
{
  "success": true,
  "result": {
    "offers": [
      {
        "offerId": "abc123...",
        "username": "friendly-panda-a1b2c3d4e5f6",
        "tags": ["chat", "video"],
        "sdp": "webrtc-offer-sdp",
        "createdAt": 1704067200000,
        "expiresAt": 1704067500000
      }
    ],
    "count": 1,
    "limit": 10,
    "offset": 0
  }
}

// Random discovery (returns single offer, no auth required)
POST /rpc
[
  {
    "method": "discover",
    "params": { "tags": ["chat"] }
  }
]
```

**Discovery modes:**
- **Paginated**: Include `limit` parameter to get array of matching offers
- **Random**: Omit `limit` to get a single random matching offer

**Tag matching:** Uses OR logic - offers matching ANY of the requested tags are returned.

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
      "offerId": "abc123...",
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
      "offerId": "abc123...",
      "candidates": [{ /* RTCIceCandidateInit */ }]
    }
  }
]

// Get ICE candidates (requires authentication)
POST /rpc
Headers:
  X-Name: friendly-panda-a1b2c3d4e5f6
  X-Timestamp: 1704067400000
  X-Nonce: 880e8400-e29b-41d4-a716-446655440003
  X-Signature: <base64-hmac-sha256-signature>
[
  {
    "method": "getIceCandidates",
    "params": {
      "offerId": "abc123...",
      "since": 0
    }
  }
]

// Poll for answers (requires authentication)
POST /rpc
Headers:
  X-Name: friendly-panda-a1b2c3d4e5f6
  X-Timestamp: 1704067500000
  X-Nonce: 990e8400-e29b-41d4-a716-446655440004
  X-Signature: <base64-hmac-sha256-signature>
[
  {
    "method": "poll",
    "params": { "since": 0 }
  }
]

// Delete offer (requires authentication, must be owner)
POST /rpc
Headers:
  X-Name: friendly-panda-a1b2c3d4e5f6
  X-Timestamp: 1704067600000
  X-Nonce: aa0e8400-e29b-41d4-a716-446655440005
  X-Signature: <base64-hmac-sha256-signature>
[
  {
    "method": "deleteOffer",
    "params": { "offerId": "abc123..." }
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
| `OFFER_MIN_TTL` | `60000` | Minimum offer TTL in milliseconds (1 minute) |
| `OFFER_MAX_TTL` | `86400000` | Maximum offer TTL in milliseconds (24 hours) |
| `OFFER_DEFAULT_TTL` | `60000` | Default offer TTL in milliseconds |
| `MASTER_ENCRYPTION_KEY` | (dev key) | 64-char hex string for encrypting secrets |
| `TIMESTAMP_MAX_AGE` | `60000` | Maximum timestamp age for replay protection |

## Security

All authenticated operations require HMAC-SHA256 signatures:
- **Credential Generation**: Generate credentials via `generateCredentials` method (returns name + secret)
- **Message Format**: `timestamp:nonce:method:JSON.stringify(params)`
- **Signature**: Base64-encoded HMAC-SHA256 signature using credential secret
- **Replay Protection**: Timestamps must be within 60 seconds + unique nonce per request
- **Secret Storage**: Secrets encrypted with AES-256-GCM using master encryption key
- **Rate Limiting**: IP-based rate limiting on credential generation (10/hour)

## Tag Validation

Tags must follow these rules:
- 1-64 characters
- Lowercase alphanumeric with optional dots and dashes
- Must start and end with alphanumeric character

Valid examples: `chat`, `video-call`, `com.example.service`, `v2`

Invalid examples: `UPPERCASE`, `-starts-dash`, `ends-dash-`

## Running Tests

```bash
# Run integration tests against api.ronde.vu
npm test

# Run against local server
API_URL=http://localhost:3000 npm test
```

## License

MIT
