# Rondevu Server

[![npm version](https://img.shields.io/npm/v/@xtr-dev/rondevu-server)](https://www.npmjs.com/package/@xtr-dev/rondevu-server)

🌐 **DNS-like WebRTC signaling with username claiming and service discovery**

Scalable WebRTC signaling server with cryptographic username claiming, service publishing, and privacy-preserving discovery.

**Related repositories:**
- [@xtr-dev/rondevu-client](https://github.com/xtr-dev/rondevu-client) - TypeScript client library ([npm](https://www.npmjs.com/package/@xtr-dev/rondevu-client))
- [@xtr-dev/rondevu-server](https://github.com/xtr-dev/rondevu-server) - HTTP signaling server ([npm](https://www.npmjs.com/package/@xtr-dev/rondevu-server), [live](https://api.ronde.vu))
- [@xtr-dev/rondevu-demo](https://github.com/xtr-dev/rondevu-demo) - Interactive demo ([live](https://ronde.vu))

---

## Features

- **Username Claiming**: Cryptographic username ownership with Ed25519 signatures (365-day validity, auto-renewed on use)
- **Service Publishing**: Package-style naming with semantic versioning (com.example.chat@1.0.0)
- **Privacy-Preserving Discovery**: UUID-based service index prevents enumeration
- **Public/Private Services**: Control service visibility
- **Stateless Authentication**: AES-256-GCM encrypted credentials, no server-side sessions
- **Complete WebRTC Signaling**: Offer/answer exchange and ICE candidate relay
- **Dual Storage**: SQLite (Node.js/Docker) and Cloudflare D1 (Workers) backends

## Architecture

```
Username Claiming → Service Publishing → Service Discovery → WebRTC Connection

alice claims "alice" with Ed25519 signature
  ↓
alice publishes com.example.chat@1.0.0 with multiple offers → receives UUID abc123
  ↓
bob requests alice/com.example.chat@1.0.0 → gets compatible service with available offer
  ↓
WebRTC connection established via offer/answer exchange
```

## Quick Start

**Node.js:**
```bash
npm install && npm start
```

**Docker:**
```bash
docker build -t rondevu . && docker run -p 3000:3000 -e STORAGE_PATH=:memory: -e AUTH_SECRET=$(openssl rand -hex 32) rondevu
```

**Cloudflare Workers:**
```bash
npx wrangler deploy
```

## API Endpoints

### Public Endpoints

#### `GET /`
Returns server version and info

#### `GET /health`
Health check endpoint with version

#### `POST /register`
Register a new peer and receive credentials (peerId + secret)

Generates a cryptographically random 128-bit peer ID.

**Response:**
```json
{
  "peerId": "f17c195f067255e357232e34cf0735d9",
  "secret": "DdorTR8QgSn9yngn+4qqR8cs1aMijvX..."
}
```

### User Management (RESTful)

#### `GET /users/:username`
Check username availability and claim status

**Response:**
```json
{
  "username": "alice",
  "available": false,
  "claimedAt": 1733404800000,
  "expiresAt": 1765027200000,
  "publicKey": "..."
}
```

#### `POST /users/:username`
Claim a username with cryptographic proof

**Request:**
```json
{
  "publicKey": "base64-encoded-ed25519-public-key",
  "signature": "base64-encoded-signature",
  "message": "claim:alice:1733404800000"
}
```

**Response:**
```json
{
  "username": "alice",
  "claimedAt": 1733404800000,
  "expiresAt": 1765027200000
}
```

**Validation:**
- Username format: `^[a-z0-9][a-z0-9-]*[a-z0-9]$` (3-32 characters)
- Signature must be valid Ed25519 signature
- Timestamp must be within 5 minutes (replay protection)
- Expires after 365 days, auto-renewed on use

#### `GET /users/:username/services/:fqn`
Get service by username and FQN with semver-compatible matching

**Semver Matching:**
- Requesting `chat@1.0.0` matches any `1.x.x` version
- Major version must match exactly (`chat@1.0.0` will NOT match `chat@2.0.0`)
- For major version 0, minor must also match (`0.1.0` will NOT match `0.2.0`)
- Returns the most recently published compatible version

**Response:**
```json
{
  "uuid": "abc123",
  "serviceId": "service-id",
  "username": "alice",
  "serviceFqn": "chat.app@1.0.0",
  "offerId": "offer-hash",
  "sdp": "v=0...",
  "isPublic": true,
  "metadata": {},
  "createdAt": 1733404800000,
  "expiresAt": 1733405100000
}
```

**Note:** Returns a single available offer from the service. If all offers are in use, returns 503.

### Service Management (RESTful)

#### `POST /users/:username/services`
Publish a service with multiple offers (requires authentication and username signature)

**Headers:**
- `Authorization: Bearer {peerId}:{secret}`

**Request:**
```json
{
  "serviceFqn": "com.example.chat@1.0.0",
  "offers": [
    { "sdp": "v=0..." },
    { "sdp": "v=0..." }
  ],
  "ttl": 300000,
  "isPublic": false,
  "metadata": { "description": "Chat service" },
  "signature": "base64-encoded-signature",
  "message": "publish:alice:com.example.chat@1.0.0:1733404800000"
}
```

**Response (Full service details):**
```json
{
  "uuid": "uuid-v4-for-index",
  "serviceId": "uuid-v4",
  "username": "alice",
  "serviceFqn": "com.example.chat@1.0.0",
  "offers": [
    {
      "offerId": "offer-hash-1",
      "sdp": "v=0...",
      "createdAt": 1733404800000,
      "expiresAt": 1733405100000
    },
    {
      "offerId": "offer-hash-2",
      "sdp": "v=0...",
      "createdAt": 1733404800000,
      "expiresAt": 1733405100000
    }
  ],
  "isPublic": false,
  "metadata": { "description": "Chat service" },
  "createdAt": 1733404800000,
  "expiresAt": 1733405100000
}
```

**Service FQN Format:**
- Service name: Reverse domain notation (e.g., `com.example.chat`)
- Version: Semantic versioning (e.g., `1.0.0`, `2.1.3-beta`)
- Complete FQN: `service-name@version` (e.g., `com.example.chat@1.0.0`)

**Validation:**
- Service name pattern: `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`
- Length: 3-128 characters
- Version pattern: `^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$`

#### `GET /services/:uuid`
Get service details by UUID

**Response:**
```json
{
  "serviceId": "...",
  "username": "alice",
  "serviceFqn": "com.example.chat@1.0.0",
  "offerId": "...",
  "sdp": "v=0...",
  "isPublic": false,
  "metadata": { ... },
  "createdAt": 1733404800000,
  "expiresAt": 1733405100000
}
```

#### `DELETE /users/:username/services/:fqn`
Unpublish a service (requires authentication and ownership)

**Headers:**
- `Authorization: Bearer {peerId}:{secret}`

**Request:**
```json
{
  "username": "alice"
}
```

### WebRTC Signaling (Service-Based)

#### `POST /services/:uuid/answer`
Answer a service offer (requires authentication)

**Headers:**
- `Authorization: Bearer {peerId}:{secret}`

**Request:**
```json
{
  "sdp": "v=0..."
}
```

**Response:**
```json
{
  "success": true,
  "offerId": "offer-hash"
}
```

#### `GET /services/:uuid/answer`
Get answer for a service (offerer polls this)

**Headers:**
- `Authorization: Bearer {peerId}:{secret}`

**Response:**
```json
{
  "offerId": "offer-hash",
  "answererId": "answerer-peer-id",
  "sdp": "v=0...",
  "answeredAt": 1733404800000
}
```

**Note:** Returns 404 if not yet answered

#### `POST /services/:uuid/ice-candidates`
Post ICE candidates for a service (requires authentication)

**Headers:**
- `Authorization: Bearer {peerId}:{secret}`

**Request:**
```json
{
  "candidates": ["candidate:1 1 UDP..."],
  "offerId": "optional-offer-id"
}
```

**Response:**
```json
{
  "count": 1,
  "offerId": "offer-hash"
}
```

**Note:** If `offerId` is omitted, the server will auto-detect the peer's offer

#### `GET /services/:uuid/ice-candidates?since=1234567890&offerId=optional-offer-id`
Get ICE candidates from the other peer (requires authentication)

**Headers:**
- `Authorization: Bearer {peerId}:{secret}`

**Response:**
```json
{
  "candidates": [
    {
      "candidate": "candidate:1 1 UDP...",
      "createdAt": 1733404800000
    }
  ],
  "offerId": "offer-hash"
}
```

**Note:** Returns candidates from the opposite role (offerer gets answerer candidates and vice versa)

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port (Node.js/Docker) |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `STORAGE_PATH` | `./rondevu.db` | SQLite database path (use `:memory:` for in-memory) |
| `VERSION` | `2.0.0` | Server version (semver) |
| `AUTH_SECRET` | Random 32-byte hex | Secret key for credential encryption (required for production) |
| `OFFER_DEFAULT_TTL` | `300000` | Default offer TTL in ms (5 minutes) |
| `OFFER_MIN_TTL` | `60000` | Minimum offer TTL in ms (1 minute) |
| `OFFER_MAX_TTL` | `3600000` | Maximum offer TTL in ms (1 hour) |
| `MAX_OFFERS_PER_REQUEST` | `10` | Maximum offers per create request |

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
- `service_fqn`: Fully qualified name (com.example.chat@1.0.0)
- `is_public`: Public/private flag
- `metadata`: JSON metadata
- `created_at`, `expires_at`: Timestamps

### offers
- `id` (PK): Offer ID (hash of SDP)
- `peer_id` (FK): Owner peer ID
- `service_id` (FK): Optional link to service (null for standalone offers)
- `sdp`: WebRTC offer SDP
- `answerer_peer_id`: Peer ID of answerer (null until answered)
- `answer_sdp`: WebRTC answer SDP (null until answered)
- `created_at`, `expires_at`, `last_seen`: Timestamps

### service_index (privacy layer)
- `uuid` (PK): Random UUID for discovery
- `service_id` (FK): Links to service
- `username`, `service_fqn`: Denormalized for performance

## Security

### Username Claiming
- **Algorithm**: Ed25519 signatures
- **Message Format**: `claim:{username}:{timestamp}`
- **Replay Protection**: Timestamp must be within 5 minutes
- **Key Management**: Private keys never leave the client

### Service Publishing
- **Ownership Verification**: Every publish requires username signature
- **Message Format**: `publish:{username}:{serviceFqn}:{timestamp}`
- **Auto-Renewal**: Publishing a service extends username expiry

### Privacy
- **Private Services**: Only UUID exposed, FQN hidden
- **Public Services**: FQN and metadata visible
- **No Enumeration**: Cannot list all services without knowing FQN

## Migration from V1

V2 is a **breaking change** that removes topic-based discovery. See [MIGRATION.md](../MIGRATION.md) for detailed migration guide.

**Key Changes:**
- ❌ Removed: Topic-based discovery, bloom filters, public peer listings
- ✅ Added: Username claiming, service publishing, UUID-based privacy

## License

MIT
