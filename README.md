# Rondevu

🎯 **Simple WebRTC peer signaling and discovery**

Meet peers by topic, by peer ID, or by connection ID.

---

## Rondevu Server

HTTP signaling server for WebRTC peer discovery and connection establishment. Supports SQLite (Node.js/Docker) and Cloudflare D1 (Workers) storage backends.

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
POST /:topic/offer {"peerId":"alice","offer":"..."}

# List sessions
GET /:topic/sessions

# Send answer
POST /answer {"code":"...","answer":"..."}

# Poll for updates
POST /poll {"code":"...","side":"offerer|answerer"}
```

See [API.md](./API.md) for details.

### Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port (Node.js/Docker) |
| `SESSION_TIMEOUT` | `300000` | Session timeout in milliseconds |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `STORAGE_PATH` | `./sessions.db` | SQLite database path (use `:memory:` for in-memory) |

### License

MIT
