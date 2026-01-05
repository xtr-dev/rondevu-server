# Rondevu Server

[![npm version](https://img.shields.io/npm/v/@xtr-dev/rondevu-server)](https://www.npmjs.com/package/@xtr-dev/rondevu-server)

**WebRTC signaling server with tags-based discovery**

HTTP signaling server with stateless Ed25519 authentication, tag-based offer discovery, and JSON-RPC interface. Multiple storage backends supported.

## Quick Start

**In-memory (default, zero dependencies):**
```bash
npm install && npm start
```

**SQLite (persistent):**
```bash
STORAGE_TYPE=sqlite STORAGE_PATH=./rondevu.db npm start
```

**MySQL:**
```bash
STORAGE_TYPE=mysql DATABASE_URL=mysql://user:pass@localhost:3306/rondevu npm start
```

**PostgreSQL:**
```bash
STORAGE_TYPE=postgres DATABASE_URL=postgres://user:pass@localhost:5432/rondevu npm start
```

**Docker:**
```bash
docker build -t rondevu . && docker run -p 3000:3000 rondevu
```

**Cloudflare Workers:**
```bash
npx wrangler deploy
```

## Storage Backends

| Backend | Use Case | Persistence |
|---------|----------|-------------|
| `memory` | Zero-config, ephemeral workloads | No |
| `sqlite` | Single-instance VPS | Yes |
| `mysql` | Production, multi-instance | Yes |
| `postgres` | Production, multi-instance | Yes |

For MySQL/PostgreSQL, install optional dependencies:
```bash
npm install mysql2  # for MySQL
npm install pg      # for PostgreSQL
```

## RPC Interface

All API calls go to `POST /rpc` with JSON-RPC format. Requests must be arrays.

### Publish Offer (authenticated)

```
Headers: X-PublicKey, X-Timestamp, X-Nonce, X-Signature
```

```json
[{
  "method": "publishOffer",
  "params": { "tags": ["chat"], "offers": [{ "sdp": "..." }], "ttl": 300000 }
}]
```

### Discover Offers (unauthenticated)

```json
[{ "method": "discover", "params": { "tags": ["chat"], "limit": 10 } }]
```

### Answer Offer (authenticated)

```json
[{ "method": "answerOffer", "params": { "offerId": "abc...", "sdp": "..." } }]
```

### Other Methods (authenticated)

- `addIceCandidates` - Add ICE candidates
- `getIceCandidates` - Get ICE candidates
- `poll` - Poll for answers and ICE candidates
- `deleteOffer` - Delete an offer

## Authentication

**Stateless Ed25519**: No registration required. Generate a keypair locally and sign requests.

```
Message: timestamp:nonce:method:canonicalJSON(params)
Headers: X-PublicKey, X-Timestamp, X-Nonce, X-Signature (base64 Ed25519)
```

The server verifies signatures directly using the public key from the header - no identity table, no registration step. Your public key IS your identity.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `STORAGE_TYPE` | `memory` | Storage backend: `memory`, `sqlite`, `mysql`, `postgres` |
| `STORAGE_PATH` | `:memory:` | SQLite path (only for `sqlite` backend) |
| `DATABASE_URL` | - | Connection string (for `mysql`/`postgres`) |
| `DB_POOL_SIZE` | `10` | Connection pool size (for `mysql`/`postgres`) |
| `CORS_ORIGINS` | `*` | Allowed origins |
| `OFFER_DEFAULT_TTL` | `60000` | Default offer TTL (ms) |
| `OFFER_MAX_TTL` | `86400000` | Max offer TTL (24h) |

## Tag Validation

Tags: 1-64 chars, lowercase alphanumeric with dots/dashes.

Valid: `chat`, `video-call`, `com.example.service`

## Links

- [Client Library](https://github.com/xtr-dev/rondevu-client) | [Demo](https://ronde.vu) | [API](https://api.ronde.vu)

## License

MIT
