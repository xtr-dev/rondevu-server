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
- **Username Claiming**: Cryptographic username ownership with Ed25519 signatures (365-day validity, auto-renewed on use)
- **Service Publishing**: Service:version@username naming (e.g., `chat:1.0.0@alice`)
- **Service Discovery**: Random and paginated discovery for finding services without knowing usernames
- **Semantic Versioning**: Compatible version matching (chat:1.0.0 matches any 1.x.x)
- **Signature-Based Authentication**: All authenticated requests use Ed25519 signatures
- **Complete WebRTC Signaling**: Offer/answer exchange and ICE candidate relay
- **Batch Operations**: Execute multiple operations in a single HTTP request
- **Dual Storage**: SQLite (Node.js/Docker) and Cloudflare D1 (Workers) backends

## Architecture

```
Username Claiming → Service Publishing → Service Discovery → WebRTC Connection

alice claims "alice" with Ed25519 signature
  ↓
alice publishes chat:1.0.0@alice with offers
  ↓
bob queries chat:1.0.0@alice (direct) or chat:1.0.0 (discovery) → gets offer SDP
  ↓
bob posts answer SDP → WebRTC connection established
  ↓
ICE candidates exchanged via server relay
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
    "method": "getService",
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

**Authentication headers (for authenticated methods):**
- `X-Username`: Your username
- `X-Timestamp`: Current timestamp (milliseconds)
- `X-Signature`: Ed25519 signature
- `X-Public-Key`: (Optional) For auto-claim

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
    "error": "Error message"
  }
]
```

Responses are returned in the same order as requests.

## Core Methods

### Username Management

```typescript
// Check username availability
POST /rpc
Headers: X-Username, X-Timestamp, X-Signature
[
  {
    "method": "getUser",
    "params": { "username": "alice" }
  }
]
```

### Service Publishing

```typescript
// Publish service (requires authentication)
POST /rpc
Headers: X-Username, X-Timestamp, X-Signature
[
  {
    "method": "publishService",
    "params": {
      "serviceFqn": "chat:1.0.0@alice",
      "offers": [{ "sdp": "webrtc-offer-sdp" }],
      "ttl": 300000
    }
  }
]
```

### Service Discovery

```typescript
// Get specific service
POST /rpc
[
  {
    "method": "getService",
    "params": { "serviceFqn": "chat:1.0.0@alice" }
  }
]

// Random discovery
POST /rpc
[
  {
    "method": "getService",
    "params": { "serviceFqn": "chat:1.0.0" }
  }
]

// Paginated discovery
POST /rpc
[
  {
    "method": "getService",
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
Headers: X-Username, X-Timestamp, X-Signature
[
  {
    "method": "answerOffer",
    "params": {
      "serviceFqn": "chat:1.0.0@alice",
      "offerId": "offer-id",
      "sdp": "webrtc-answer-sdp"
    }
  }
]

// Add ICE candidates (requires authentication)
POST /rpc
Headers: X-Username, X-Timestamp, X-Signature
[
  {
    "method": "addIceCandidates",
    "params": {
      "serviceFqn": "chat:1.0.0@alice",
      "offerId": "offer-id",
      "candidates": [{ /* RTCIceCandidateInit */ }]
    }
  }
]

// Poll for answers and ICE candidates (requires authentication)
POST /rpc
Headers: X-Username, X-Timestamp, X-Signature
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

📚 See [ADVANCED.md](./ADVANCED.md#configuration) for complete configuration reference.

## Documentation

📚 **[ADVANCED.md](./ADVANCED.md)** - Comprehensive guide including:
- Complete RPC method reference with examples
- Full configuration options
- Database schema documentation
- Security implementation details
- Migration guides

## Security

All authenticated operations require Ed25519 signatures:
- **Message Format**: `{method}:{username}:{context}:{timestamp}`
- **Signature**: Base64-encoded Ed25519 signature of the message
- **Replay Protection**: Timestamps must be within 5 minutes
- **Username Ownership**: Verified via public key signature

See [ADVANCED.md](./ADVANCED.md#security) for detailed security documentation.

## Changelog

### v0.5.3 (Latest)
- Fix RPC method calls using non-existent storage methods
- Replace `storage.getServicesByName()` with `storage.discoverServices()` and `storage.getRandomService()`
- Ensures compatibility with Storage interface specification

## License

MIT
