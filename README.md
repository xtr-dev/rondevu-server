# Rondevu Server

🌐 **Topic-based peer discovery and WebRTC signaling**

Scalable peer-to-peer connection establishment with topic-based discovery, stateless authentication, and complete WebRTC signaling.

**Related repositories:**
- [@xtr-dev/rondevu-client](https://www.npmjs.com/package/@xtr-dev/rondevu-client) - TypeScript client library
- [rondevu-demo](https://rondevu-demo.pages.dev) - Interactive demo

---

## Features

- **Topic-Based Discovery**: Tag offers with topics (e.g., torrent infohashes) for efficient peer finding
- **Stateless Authentication**: AES-256-GCM encrypted credentials, no server-side sessions
- **Bloom Filters**: Client-side peer exclusion for efficient discovery
- **Multi-Offer Support**: Create multiple offers per peer simultaneously
- **Complete WebRTC Signaling**: Offer/answer exchange and ICE candidate relay
- **Dual Storage**: SQLite (Node.js/Docker) and Cloudflare D1 (Workers) backends

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

#### `GET /health`
Health check endpoint with version

#### `POST /register`
Register a new peer and receive credentials (peerId + secret)

**Response:**
```json
{
  "peerId": "f17c195f067255e357232e34cf0735d9",
  "secret": "DdorTR8QgSn9yngn+4qqR8cs1aMijvX..."
}
```

#### `GET /topics?limit=50&offset=0`
List all topics with active peer counts (paginated)

**Query Parameters:**
- `limit` (optional): Maximum number of topics to return (default: 50, max: 200)
- `offset` (optional): Number of topics to skip (default: 0)

**Response:**
```json
{
  "topics": [
    {"topic": "movie-xyz", "activePeers": 42},
    {"topic": "torrent-abc", "activePeers": 15}
  ],
  "total": 123,
  "limit": 50,
  "offset": 0
}
```

#### `GET /offers/by-topic/:topic?limit=50&bloom=...`
Find offers by topic with optional bloom filter exclusion

**Query Parameters:**
- `limit` (optional): Maximum offers to return (default: 50, max: 200)
- `bloom` (optional): Base64-encoded bloom filter to exclude known peers

**Response:**
```json
{
  "topic": "movie-xyz",
  "offers": [
    {
      "id": "offer-id",
      "peerId": "peer-id",
      "sdp": "v=0...",
      "topics": ["movie-xyz", "hd-content"],
      "expiresAt": 1234567890,
      "lastSeen": 1234567890
    }
  ],
  "total": 42,
  "returned": 10
}
```

#### `GET /peers/:peerId/offers`
View all offers from a specific peer

### Authenticated Endpoints

All authenticated endpoints require `Authorization: Bearer {peerId}:{secret}` header.

#### `POST /offers`
Create one or more offers

**Request:**
```json
{
  "offers": [
    {
      "sdp": "v=0...",
      "topics": ["movie-xyz", "hd-content"],
      "ttl": 300000
    }
  ]
}
```

#### `GET /offers/mine`
List all offers owned by authenticated peer

#### `PUT /offers/:offerId/heartbeat`
Update last_seen timestamp for an offer

#### `DELETE /offers/:offerId`
Delete a specific offer

#### `POST /offers/:offerId/answer`
Answer an offer (locks it to answerer)

**Request:**
```json
{
  "sdp": "v=0..."
}
```

#### `GET /offers/answers`
Poll for answers to your offers

#### `POST /offers/:offerId/ice-candidates`
Post ICE candidates for an offer

**Request:**
```json
{
  "candidates": ["candidate:1 1 UDP..."]
}
```

#### `GET /offers/:offerId/ice-candidates?since=1234567890`
Get ICE candidates from the other peer

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port (Node.js/Docker) |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `STORAGE_PATH` | `./rondevu.db` | SQLite database path (use `:memory:` for in-memory) |
| `VERSION` | `0.4.0` | Server version (semver) |
| `AUTH_SECRET` | Random 32-byte hex | Secret key for credential encryption |
| `OFFER_DEFAULT_TTL` | `300000` | Default offer TTL in ms (5 minutes) |
| `OFFER_MIN_TTL` | `60000` | Minimum offer TTL in ms (1 minute) |
| `OFFER_MAX_TTL` | `3600000` | Maximum offer TTL in ms (1 hour) |
| `MAX_OFFERS_PER_REQUEST` | `10` | Maximum offers per create request |
| `MAX_TOPICS_PER_OFFER` | `20` | Maximum topics per offer |

## License

MIT
