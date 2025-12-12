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

### Request Format

**Single method call:**
```json
{
  "method": "getUser",
  "message": "getUser:alice:1733404800000",
  "signature": "base64-encoded-signature",
  "params": {
    "username": "alice"
  }
}
```

**Batch calls:**
```json
[
  {
    "method": "getUser",
    "message": "getUser:alice:1733404800000",
    "signature": "base64-encoded-signature",
    "params": { "username": "alice" }
  },
  {
    "method": "claimUsername",
    "message": "claim:bob:1733404800000",
    "signature": "base64-encoded-signature",
    "params": {
      "username": "bob",
      "publicKey": "base64-encoded-public-key"
    }
  }
]
```

### Response Format

**Single response:**
```json
{
  "success": true,
  "result": {
    "username": "alice",
    "available": false,
    "claimedAt": 1733404800000,
    "expiresAt": 1765027200000,
    "publicKey": "base64-encoded-public-key"
  }
}
```

**Batch responses:**
```json
[
  {
    "success": true,
    "result": { "username": "alice", "available": false }
  },
  {
    "success": true,
    "result": { "success": true, "username": "bob" }
  }
]
```

**Error response:**
```json
{
  "success": false,
  "error": "Username already claimed by different public key"
}
```

## RPC Methods

### `getUser`
Check username availability

**Parameters:**
- `username` - Username to check

**Message format:** `getUser:{username}:{timestamp}` (no authentication required)

**Example:**
```json
{
  "method": "getUser",
  "message": "getUser:alice:1733404800000",
  "signature": "base64-signature",
  "params": { "username": "alice" }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "username": "alice",
    "available": false,
    "claimedAt": 1733404800000,
    "expiresAt": 1765027200000,
    "publicKey": "base64-encoded-public-key"
  }
}
```

### `claimUsername`
Claim a username with cryptographic proof

**Parameters:**
- `username` - Username to claim
- `publicKey` - Base64-encoded Ed25519 public key

**Message format:** `claim:{username}:{timestamp}`

**Example:**
```json
{
  "method": "claimUsername",
  "message": "claim:alice:1733404800000",
  "signature": "base64-signature",
  "params": {
    "username": "alice",
    "publicKey": "base64-encoded-public-key"
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "success": true,
    "username": "alice"
  }
}
```

### `getService`
Get service by FQN (direct lookup, random discovery, or paginated)

**Parameters:**
- `serviceFqn` - Service FQN (e.g., `chat:1.0.0` or `chat:1.0.0@alice`)
- `limit` - (optional) Number of results for paginated mode
- `offset` - (optional) Offset for paginated mode

**Message format:** `getService:{username}:{serviceFqn}:{timestamp}`

**Modes:**
1. **Direct lookup** (with @username): Returns specific user's service
2. **Random** (without @username, no limit): Returns random service
3. **Paginated** (without @username, with limit): Returns multiple services

**Example:**
```json
{
  "method": "getService",
  "message": "getService:bob:chat:1.0.0:1733404800000",
  "signature": "base64-signature",
  "params": {
    "serviceFqn": "chat:1.0.0@alice"
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "serviceId": "uuid",
    "username": "alice",
    "serviceFqn": "chat:1.0.0@alice",
    "offerId": "offer-hash",
    "sdp": "v=0...",
    "createdAt": 1733404800000,
    "expiresAt": 1733405100000
  }
}
```

### `publishService`
Publish a service with offers

**Parameters:**
- `serviceFqn` - Service FQN with username (e.g., `chat:1.0.0@alice`)
- `offers` - Array of offers, each with `sdp` field
- `ttl` - (optional) Time to live in milliseconds

**Message format:** `publishService:{username}:{serviceFqn}:{timestamp}`

**Example:**
```json
{
  "method": "publishService",
  "message": "publishService:alice:chat:1.0.0@alice:1733404800000",
  "signature": "base64-signature",
  "params": {
    "serviceFqn": "chat:1.0.0@alice",
    "offers": [
      { "sdp": "v=0..." },
      { "sdp": "v=0..." }
    ],
    "ttl": 300000
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "serviceId": "uuid",
    "username": "alice",
    "serviceFqn": "chat:1.0.0@alice",
    "offers": [
      {
        "offerId": "offer-hash-1",
        "sdp": "v=0...",
        "createdAt": 1733404800000,
        "expiresAt": 1733405100000
      }
    ],
    "createdAt": 1733404800000,
    "expiresAt": 1733405100000
  }
}
```

### `deleteService`
Delete a service

**Parameters:**
- `serviceFqn` - Service FQN with username

**Message format:** `deleteService:{username}:{serviceFqn}:{timestamp}`

**Example:**
```json
{
  "method": "deleteService",
  "message": "deleteService:alice:chat:1.0.0@alice:1733404800000",
  "signature": "base64-signature",
  "params": {
    "serviceFqn": "chat:1.0.0@alice"
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": { "success": true }
}
```

### `answerOffer`
Answer a specific offer

**Parameters:**
- `serviceFqn` - Service FQN
- `offerId` - Offer ID
- `sdp` - Answer SDP

**Message format:** `answerOffer:{username}:{offerId}:{timestamp}`

**Example:**
```json
{
  "method": "answerOffer",
  "message": "answerOffer:bob:offer-hash:1733404800000",
  "signature": "base64-signature",
  "params": {
    "serviceFqn": "chat:1.0.0@alice",
    "offerId": "offer-hash",
    "sdp": "v=0..."
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "success": true,
    "offerId": "offer-hash"
  }
}
```

### `getOfferAnswer`
Get answer for an offer (offerer polls this)

**Parameters:**
- `serviceFqn` - Service FQN
- `offerId` - Offer ID

**Message format:** `getOfferAnswer:{username}:{offerId}:{timestamp}`

**Example:**
```json
{
  "method": "getOfferAnswer",
  "message": "getOfferAnswer:alice:offer-hash:1733404800000",
  "signature": "base64-signature",
  "params": {
    "serviceFqn": "chat:1.0.0@alice",
    "offerId": "offer-hash"
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "sdp": "v=0...",
    "offerId": "offer-hash",
    "answererId": "bob",
    "answeredAt": 1733404800000
  }
}
```

### `poll`
Combined polling for answers and ICE candidates

**Parameters:**
- `since` - (optional) Timestamp to get only new data

**Message format:** `poll:{username}:{timestamp}`

**Example:**
```json
{
  "method": "poll",
  "message": "poll:alice:1733404800000",
  "signature": "base64-signature",
  "params": {
    "since": 1733404800000
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "answers": [
      {
        "offerId": "offer-hash",
        "serviceId": "service-uuid",
        "answererId": "bob",
        "sdp": "v=0...",
        "answeredAt": 1733404800000
      }
    ],
    "iceCandidates": {
      "offer-hash": [
        {
          "candidate": { "candidate": "...", "sdpMid": "0", "sdpMLineIndex": 0 },
          "role": "answerer",
          "username": "bob",
          "createdAt": 1733404800000
        }
      ]
    }
  }
}
```

### `addIceCandidates`
Add ICE candidates to an offer

**Parameters:**
- `serviceFqn` - Service FQN
- `offerId` - Offer ID
- `candidates` - Array of ICE candidates

**Message format:** `addIceCandidates:{username}:{offerId}:{timestamp}`

**Example:**
```json
{
  "method": "addIceCandidates",
  "message": "addIceCandidates:alice:offer-hash:1733404800000",
  "signature": "base64-signature",
  "params": {
    "serviceFqn": "chat:1.0.0@alice",
    "offerId": "offer-hash",
    "candidates": [
      {
        "candidate": "candidate:...",
        "sdpMid": "0",
        "sdpMLineIndex": 0
      }
    ]
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "count": 1,
    "offerId": "offer-hash"
  }
}
```

### `getIceCandidates`
Get ICE candidates for an offer

**Parameters:**
- `serviceFqn` - Service FQN
- `offerId` - Offer ID
- `since` - (optional) Timestamp to get only new candidates

**Message format:** `getIceCandidates:{username}:{offerId}:{timestamp}`

**Example:**
```json
{
  "method": "getIceCandidates",
  "message": "getIceCandidates:alice:offer-hash:1733404800000",
  "signature": "base64-signature",
  "params": {
    "serviceFqn": "chat:1.0.0@alice",
    "offerId": "offer-hash",
    "since": 1733404800000
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "candidates": [
      {
        "candidate": {
          "candidate": "candidate:...",
          "sdpMid": "0",
          "sdpMLineIndex": 0
        },
        "createdAt": 1733404800000
      }
    ],
    "offerId": "offer-hash"
  }
}
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port (Node.js/Docker) |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `STORAGE_PATH` | `./rondevu.db` | SQLite database path (use `:memory:` for in-memory) |
| `VERSION` | `0.5.0` | Server version (semver) |
| `OFFER_DEFAULT_TTL` | `60000` | Default offer TTL in ms (1 minute) |
| `OFFER_MIN_TTL` | `60000` | Minimum offer TTL in ms (1 minute) |
| `OFFER_MAX_TTL` | `86400000` | Maximum offer TTL in ms (24 hours) |
| `CLEANUP_INTERVAL` | `60000` | Cleanup interval in ms (1 minute) |
| `MAX_OFFERS_PER_REQUEST` | `100` | Maximum offers per create request |

## Database Schema

### usernames
- `username` (PK): Claimed username
- `public_key`: Ed25519 public key (base64)
- `claimed_at`: Claim timestamp
- `expires_at`: Expiry timestamp (365 days)
- `last_used`: Last activity timestamp
- `metadata`: Optional JSON metadata

### services
- `id` (PK): Service ID (UUID)
- `username` (FK): Owner username
- `service_fqn`: Fully qualified name (chat:1.0.0@alice)
- `service_name`: Service name component (chat)
- `version`: Version component (1.0.0)
- `created_at`, `expires_at`: Timestamps
- UNIQUE constraint on (service_name, version, username)

### offers
- `id` (PK): Offer ID (hash of SDP)
- `username` (FK): Owner username
- `service_id` (FK): Link to service
- `service_fqn`: Denormalized service FQN
- `sdp`: WebRTC offer SDP
- `answerer_username`: Username of answerer (null until answered)
- `answer_sdp`: WebRTC answer SDP (null until answered)
- `answered_at`: Timestamp when answered
- `created_at`, `expires_at`, `last_seen`: Timestamps

### ice_candidates
- `id` (PK): Auto-increment ID
- `offer_id` (FK): Link to offer
- `username`: Username who sent the candidate
- `role`: 'offerer' or 'answerer'
- `candidate`: JSON-encoded candidate
- `created_at`: Timestamp

## Security

### Ed25519 Signature Authentication
All authenticated requests require:
- **message**: Signed message with format-specific structure
- **signature**: Base64-encoded Ed25519 signature of the message
- Username is extracted from the message

### Username Claiming
- **Algorithm**: Ed25519 signatures
- **Message Format**: `claim:{username}:{timestamp}`
- **Replay Protection**: Timestamp must be within 5 minutes
- **Key Management**: Private keys never leave the client
- **Validity**: 365 days, auto-renewed on use

### Anonymous Users
- **Format**: `anon-{timestamp}-{random}` (e.g., `anon-lx2w34-a3f501`)
- **Generation**: Can be generated by client for testing
- **Behavior**: Same as regular usernames, must be explicitly claimed like any username

### Service Publishing
- **Ownership Verification**: Every publish requires username signature
- **Message Format**: `publishService:{username}:{serviceFqn}:{timestamp}`
- **Auto-Renewal**: Publishing a service extends username expiry

### ICE Candidate Filtering
- Server filters candidates by role to prevent peers from receiving their own candidates
- Offerers receive only answerer candidates
- Answerers receive only offerer candidates

## Migration from v0.4.x

See [MIGRATION.md](../MIGRATION.md) for detailed migration guide.

**Key Changes:**
- Moved from REST API to RPC interface with single `/rpc` endpoint
- All methods now use POST with JSON body
- Batch operations supported
- Authentication is per-method instead of per-endpoint middleware

## License

MIT
