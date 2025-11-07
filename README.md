# Rondevu

🎯 Meet WebRTC peers by topic, by peer ID, or by connection ID.

## Rondevu Server

A simple HTTP server for WebRTC peer signaling and discovery.

**Three ways to connect:** by topic, by peer ID, or by connection ID.

### Quick Start

**Node.js:**
```bash
npm install && npm start
```

**Docker:**
```bash
docker build -t rondevu . && docker run -p 3000:3000 rondevu
```

**Cloudflare Workers:**
```bash
npx wrangler deploy
```

See [DEPLOYMENT.md](./DEPLOYMENT.md) for details.

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

```env
PORT=3000
SESSION_TIMEOUT=300000
CORS_ORIGINS=*
```

### Storage

Supports SQLite (Node.js/Docker) or D1 (Cloudflare Workers).

### License

MIT
