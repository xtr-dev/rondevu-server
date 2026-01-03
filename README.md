# Rondevu Server

[![npm version](https://img.shields.io/npm/v/@xtr-dev/rondevu-server)](https://www.npmjs.com/package/@xtr-dev/rondevu-server)

**WebRTC signaling server with tags-based discovery**

HTTP signaling server with credential-based authentication, tag-based offer discovery, and JSON-RPC interface. Supports SQLite (Node.js) and Cloudflare D1 (Workers).

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

All API calls go to `POST /rpc` with JSON-RPC format. Requests must be arrays.

### Generate Credentials

```json
[{ "method": "generateCredentials", "params": { "name": "alice" } }]
```

Response:
```json
[{ "success": true, "result": { "name": "alice", "secret": "5a7f3e..." } }]
```

### Publish Offer (authenticated)

```
Headers: X-Name, X-Timestamp, X-Nonce, X-Signature
```

```json
[{
  "method": "publishOffer",
  "params": { "tags": ["chat"], "offers": [{ "sdp": "..." }], "ttl": 300000 }
}]
```

### Discover Offers

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
- `poll` - Poll for answers
- `deleteOffer` - Delete an offer

## Authentication

Authenticated methods require HMAC-SHA256 signatures:

```
Message: timestamp:nonce:method:JSON.stringify(params)
Headers: X-Name, X-Timestamp, X-Nonce, X-Signature (base64 HMAC)
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `STORAGE_PATH` | `./rondevu.db` | SQLite path (`:memory:` for in-memory) |
| `CORS_ORIGINS` | `*` | Allowed origins |
| `MASTER_ENCRYPTION_KEY` | - | 64-char hex for secret encryption |
| `OFFER_DEFAULT_TTL` | `60000` | Default offer TTL (ms) |
| `OFFER_MAX_TTL` | `86400000` | Max offer TTL (24h) |

Generate encryption key: `openssl rand -hex 32`

## Tag Validation

Tags: 1-64 chars, lowercase alphanumeric with dots/dashes.

Valid: `chat`, `video-call`, `com.example.service`

## Links

- [Client Library](https://github.com/xtr-dev/rondevu-client) | [Demo](https://ronde.vu) | [API](https://api.ronde.vu)

## License

MIT
