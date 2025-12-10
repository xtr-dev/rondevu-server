# Rondevu Server

[![npm version](https://img.shields.io/npm/v/@xtr-dev/rondevu-server)](https://www.npmjs.com/package/@xtr-dev/rondevu-server)

🌐 **Simple WebRTC signaling with username-based discovery**

Scalable WebRTC signaling server with cryptographic username claiming, service publishing with semantic versioning, and efficient offer/answer exchange.

**Related repositories:**
- [@xtr-dev/rondevu-client](https://github.com/xtr-dev/rondevu-client) - TypeScript client library ([npm](https://www.npmjs.com/package/@xtr-dev/rondevu-client))
- [@xtr-dev/rondevu-server](https://github.com/xtr-dev/rondevu-server) - HTTP signaling server ([npm](https://www.npmjs.com/package/@xtr-dev/rondevu-server), [live](https://api.ronde.vu))
- [@xtr-dev/rondevu-demo](https://github.com/xtr-dev/rondevu-demo) - Interactive demo ([live](https://ronde.vu))

---

## Features

- **Username Claiming**: Cryptographic username ownership with Ed25519 signatures (365-day validity, auto-renewed on use)
- **Anonymous Users**: Auto-generated anonymous usernames for quick testing without claiming
- **Service Publishing**: Service:version@username naming (e.g., `chat:1.0.0@alice`)
- **Service Discovery**: Random and paginated discovery for finding services without knowing usernames
- **Semantic Versioning**: Compatible version matching (chat:1.0.0 matches any 1.x.x)
- **Signature-Based Authentication**: All authenticated requests use Ed25519 signatures
- **Complete WebRTC Signaling**: Offer/answer exchange and ICE candidate relay
- **Efficient Batch Polling**: Combined endpoint for answers and ICE candidates (50% fewer HTTP requests)
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

## API Endpoints

### Public Endpoints

#### `GET /`
Returns server version and info

**Response:**
```json
{
  "version": "0.4.0",
  "name": "Rondevu",
  "description": "DNS-like WebRTC signaling with username claiming and service discovery"
}
```

#### `GET /health`
Health check endpoint with version

**Response:**
```json
{
  "status": "ok",
  "timestamp": 1733404800000,
  "version": "0.4.0"
}
```

### User Management

#### `GET /users/:username`
Check username availability and claim status

**Response (Available):**
```json
{
  "username": "alice",
  "available": true
}
```

**Response (Claimed):**
```json
{
  "username": "alice",
  "available": false,
  "claimedAt": 1733404800000,
  "expiresAt": 1765027200000,
  "publicKey": "base64-encoded-ed25519-public-key"
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
  "success": true,
  "username": "alice"
}
```

**Validation:**
- Username format: `^[a-z0-9][a-z0-9-]*[a-z0-9]$` (3-32 characters)
- Signature must be valid Ed25519 signature
- Timestamp must be within 5 minutes (replay protection)
- Expires after 365 days, auto-renewed on use

### Service Management

#### `POST /services`
Publish a service with offers (requires username and signature)

**Request:**
```json
{
  "username": "alice",
  "serviceFqn": "chat:1.0.0@alice",
  "offers": [
    { "sdp": "v=0..." },
    { "sdp": "v=0..." }
  ],
  "ttl": 300000,
  "signature": "base64-encoded-signature",
  "message": "publish:alice:chat:1.0.0@alice:1733404800000"
}
```

**Response:**
```json
{
  "serviceId": "uuid-v4",
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
```

**Service FQN Format:**
- Format: `service:version@username`
- Service name: Lowercase alphanumeric + dash (e.g., `chat`, `video-call`)
- Version: Semantic versioning (e.g., `1.0.0`, `2.1.3`)
- Username: Claimed username
- Example: `chat:1.0.0@alice`

**Validation:**
- Service name pattern: `^[a-z0-9][a-z0-9-]*[a-z0-9]$`
- Version pattern: `^[0-9]+\.[0-9]+\.[0-9]+$`
- Must include @username

#### `GET /services/:fqn`
Get service by FQN - Three modes:

**1. Direct Lookup (with username):**
```
GET /services/chat:1.0.0@alice
```
Returns first available offer from Alice's chat:1.0.0 service.

**2. Random Discovery (without username):**
```
GET /services/chat:1.0.0
```
Returns a random available offer from any user's chat:1.0.0 service.

**3. Paginated Discovery (with query params):**
```
GET /services/chat:1.0.0?limit=10&offset=0
```
Returns array of unique available offers from different users.

**Semver Matching:**
- Requesting `chat:1.0.0` matches any `1.x.x` version
- Major version must match exactly (`chat:1.0.0` will NOT match `chat:2.0.0`)
- For major version 0, minor must also match (`0.1.0` will NOT match `0.2.0`)
- Returns the most recently published compatible version

**Response (Single Offer):**
```json
{
  "serviceId": "uuid",
  "username": "alice",
  "serviceFqn": "chat:1.0.0@alice",
  "offerId": "offer-hash",
  "sdp": "v=0...",
  "createdAt": 1733404800000,
  "expiresAt": 1733405100000
}
```

**Response (Paginated):**
```json
{
  "services": [
    {
      "serviceId": "uuid",
      "username": "alice",
      "serviceFqn": "chat:1.0.0@alice",
      "offerId": "offer-hash",
      "sdp": "v=0...",
      "createdAt": 1733404800000,
      "expiresAt": 1733405100000
    }
  ],
  "count": 1,
  "limit": 10,
  "offset": 0
}
```

#### `DELETE /services/:fqn`
Unpublish a service (requires username, signature, and ownership)

**Query Parameters:**
- `username` - Your username
- `signature` - Base64-encoded Ed25519 signature
- `message` - Signed message (format: `deleteService:{username}:{serviceFqn}:{timestamp}`)

**Response:**
```json
{
  "success": true
}
```

### WebRTC Signaling

#### `POST /services/:fqn/offers/:offerId/answer`
Post answer SDP to specific offer

**Request:**
```json
{
  "username": "bob",
  "sdp": "v=0...",
  "signature": "base64-encoded-signature",
  "message": "answerOffer:{username}:{offerId}:{timestamp}"
}
```

**Response:**
```json
{
  "success": true,
  "offerId": "offer-hash"
}
```

#### `GET /services/:fqn/offers/:offerId/answer`
Get answer SDP (offerer polls this)

**Query Parameters:**
- `username` - Your username
- `signature` - Base64-encoded Ed25519 signature
- `message` - Signed message (format: `getAnswer:{username}:{offerId}:{timestamp}`)

**Response:**
```json
{
  "sdp": "v=0...",
  "offerId": "offer-hash",
  "answererUsername": "bob",
  "answeredAt": 1733404800000
}
```

Returns 404 if not yet answered.

#### `GET /offers/answered`
Get all answered offers (efficient batch polling for offerer)

**Query Parameters:**
- `username` - Your username
- `signature` - Base64-encoded Ed25519 signature
- `message` - Signed message (format: `getAnsweredOffers:{username}:{timestamp}`)
- `since` - Optional timestamp to get only new answers

**Response:**
```json
{
  "offers": [
    {
      "offerId": "offer-hash",
      "serviceId": "service-uuid",
      "answererUsername": "bob",
      "sdp": "v=0...",
      "answeredAt": 1733404800000
    }
  ]
}
```

#### `GET /offers/poll`
Combined polling for answers and ICE candidates (offerer)

**Query Parameters:**
- `username` - Your username
- `signature` - Base64-encoded Ed25519 signature
- `message` - Signed message (format: `pollOffers:{username}:{timestamp}`)
- `since` - Optional timestamp to get only new data

**Response:**
```json
{
  "answers": [
    {
      "offerId": "offer-hash",
      "serviceId": "service-uuid",
      "answererUsername": "bob",
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
```

More efficient than polling answers and ICE separately - reduces HTTP requests by 50%.

#### `POST /services/:fqn/offers/:offerId/ice-candidates`
Add ICE candidates to specific offer

**Request:**
```json
{
  "username": "alice",
  "candidates": [
    {
      "candidate": "candidate:...",
      "sdpMid": "0",
      "sdpMLineIndex": 0
    }
  ],
  "signature": "base64-encoded-signature",
  "message": "addIceCandidates:{username}:{offerId}:{timestamp}"
}
```

**Response:**
```json
{
  "count": 1,
  "offerId": "offer-hash"
}
```

#### `GET /services/:fqn/offers/:offerId/ice-candidates`
Get ICE candidates for specific offer

**Query Parameters:**
- `username` - Your username
- `signature` - Base64-encoded Ed25519 signature
- `message` - Signed message (format: `getIceCandidates:{username}:{offerId}:{timestamp}`)
- `since` - Optional timestamp to get only new candidates

**Response:**
```json
{
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
```

**Note:** Returns candidates from the opposite role (offerer gets answerer candidates and vice versa)

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
- **username**: Your claimed username
- **signature**: Base64-encoded Ed25519 signature of the message
- **message**: Signed message with format-specific structure

### Username Claiming
- **Algorithm**: Ed25519 signatures
- **Message Format**: `claim:{username}:{timestamp}`
- **Replay Protection**: Timestamp must be within 5 minutes
- **Key Management**: Private keys never leave the client
- **Validity**: 365 days, auto-renewed on use

### Anonymous Users
- **Format**: `anon-{timestamp}-{random}` (e.g., `anon-lx2w34-a3f501`)
- **Generation**: Auto-generated by client for testing
- **Behavior**: Same as regular usernames, can be claimed

### Service Publishing
- **Ownership Verification**: Every publish requires username signature
- **Message Format**: `publish:{username}:{serviceFqn}:{timestamp}`
- **Auto-Renewal**: Publishing a service extends username expiry

### ICE Candidate Filtering
- Server filters candidates by role to prevent peers from receiving their own candidates
- Offerers receive only answerer candidates
- Answerers receive only offerer candidates

## Migration from v0.3.x

See [MIGRATION.md](../MIGRATION.md) for detailed migration guide.

**Key Changes:**
- Service FQN format changed from `service@version` to `service:version@username`
- Removed UUID privacy layer - direct FQN-based access
- Removed public/private service distinction
- Added service discovery (random and paginated)
- Added combined polling endpoint (/offers/poll)
- ICE candidate endpoints moved to offer-specific routes

## License

MIT
