# Rondevu

🎯 **Simple WebRTC peer signaling**

Direct peer-to-peer connections via offer/answer exchange.

**Related repositories:**
- [rondevu-client](https://github.com/xtr-dev/rondevu-client) - TypeScript client library
- [rondevu-demo](https://github.com/xtr-dev/rondevu-demo) - Interactive demo

---

## Rondevu Server

HTTP signaling server for WebRTC peer connection establishment. Supports SQLite (Node.js/Docker) and Cloudflare D1 (Workers) storage backends.

### Quick Start

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

### API

```bash
# Create offer
POST /offer {"peerId":"alice","offer":"...","code":"my-room"}

# Send answer/candidates
POST /answer {"code":"my-room","answer":"...","side":"answerer"}

# Poll for updates
POST /poll {"code":"my-room","side":"offerer"}

# Health check with version
GET /health

# Version info
GET /
```

### Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port (Node.js/Docker) |
| `OFFER_TIMEOUT` | `60000` | Offer timeout in milliseconds (1 minute) |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `STORAGE_PATH` | `./offers.db` | SQLite database path (use `:memory:` for in-memory) |
| `VERSION` | `0.0.1` | Server version (semver) |

### License

MIT
