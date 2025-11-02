# Rondevu

An open signaling and tracking server for peer discovery. Enables peers to find each other through a topic-based HTTP API with Origin isolation for organizing peer-to-peer applications.

## Features

- 🚀 **Fast & Lightweight** - Built with [Hono](https://hono.dev/) framework
- 📂 **Topic-Based Organization** - Group sessions by topic for easy peer discovery
- 🔒 **Origin Isolation** - Sessions are isolated by HTTP Origin header to group topics by domain
- 🏷️ **Peer Identification** - Info field prevents duplicate connections to same peer
- 🔌 **Pluggable Storage** - Storage interface supports SQLite and in-memory adapters
- 🐳 **Docker Ready** - Minimal Alpine-based Docker image
- ⏱️ **Session Timeout** - Configurable session expiration from initiation time
- 🔐 **Type Safe** - Written in TypeScript with full type definitions

## Quick Start

### Using Node.js

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build and run in production
npm run build
npm start
```

### Using Docker

```bash
# Build the image
docker build -t rondevu .

# Run with default settings (SQLite database)
docker run -p 3000:3000 rondevu

# Run with in-memory storage
docker run -p 3000:3000 -e STORAGE_TYPE=memory rondevu

# Run with custom timeout (10 minutes)
docker run -p 3000:3000 -e SESSION_TIMEOUT=600000 rondevu
```

### Using Cloudflare Workers

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Create KV namespace
wrangler kv:namespace create SESSIONS

# Update wrangler.toml with the KV namespace ID

# Deploy to Cloudflare's edge network
npx wrangler deploy
```

See [DEPLOYMENT.md](./DEPLOYMENT.md#cloudflare-workers) for detailed instructions.

## Configuration

Configuration is done through environment variables:

| Variable           | Description                                      | Default     |
|--------------------|--------------------------------------------------|-------------|
| `PORT`             | Server port                                      | `3000`      |
| `STORAGE_TYPE`     | Storage backend: `sqlite` or `memory`            | `sqlite`    |
| `STORAGE_PATH`     | Path to SQLite database file                     | `./data.db` |
| `SESSION_TIMEOUT`  | Session timeout in milliseconds                  | `300000`    |
| `CORS_ORIGINS`     | Comma-separated list of allowed origins          | `*`         |

### Example .env file

```env
PORT=3000
STORAGE_TYPE=sqlite
STORAGE_PATH=./sessions.db
SESSION_TIMEOUT=300000
CORS_ORIGINS=https://example.com,https://app.example.com
```

## API Documentation

See [API.md](./API.md) for complete API documentation.

### Quick Overview

**List all active topics (with pagination):**
```bash
curl -X GET http://localhost:3000/ \
  -H "Origin: https://example.com"
# Returns: {"topics":[{"topic":"my-room","count":3}],"pagination":{...}}
```

**Create an offer (announce yourself as available):**
```bash
curl -X POST http://localhost:3000/my-room/offer \
  -H "Content-Type: application/json" \
  -H "Origin: https://example.com" \
  -d '{"info":"peer-123","offer":"<SIGNALING_DATA>"}'
# Returns: {"code":"550e8400-e29b-41d4-a716-446655440000"}
```

**List available peers in a topic:**
```bash
curl -X GET http://localhost:3000/my-room/sessions \
  -H "Origin: https://example.com"
# Returns: {"sessions":[...]}
```

**Connect to a peer:**
```bash
curl -X POST http://localhost:3000/answer \
  -H "Content-Type: application/json" \
  -H "Origin: https://example.com" \
  -d '{"code":"550e8400-...","answer":"<SIGNALING_DATA>","side":"answerer"}'
# Returns: {"success":true}
```

## Architecture

### Storage Interface

The storage layer is abstracted through a simple interface, making it easy to implement custom storage backends:

```typescript
interface Storage {
  createSession(origin: string, topic: string, info: string, offer: string, expiresAt: number): Promise<string>;
  listSessionsByTopic(origin: string, topic: string): Promise<Session[]>;
  getSession(code: string, origin: string): Promise<Session | null>;
  updateSession(code: string, origin: string, update: Partial<Session>): Promise<void>;
  deleteSession(code: string): Promise<void>;
  cleanup(): Promise<void>;
  close(): Promise<void>;
}
```

### Built-in Storage Adapters

**SQLite Storage** (`sqlite.ts`)
- For Node.js/Docker deployments
- Persistent file-based or in-memory
- Automatic session cleanup
- Simple and reliable

**Cloudflare KV Storage** (`kv.ts`)
- For Cloudflare Workers deployments
- Global edge storage
- Automatic TTL-based expiration
- Distributed and highly available

### Custom Storage Adapters

You can implement your own storage adapter by implementing the `Storage` interface:

```typescript
import { Storage, Session } from './storage/types';

export class CustomStorage implements Storage {
  async createSession(offer: string, expiresAt: number): Promise<string> {
    // Your implementation
  }
  // ... implement other methods
}
```

## Development

### Project Structure

```
rondevu/
├── src/
│   ├── index.ts           # Node.js server entry point
│   ├── app.ts             # Hono application
│   ├── config.ts          # Configuration
│   └── storage/
│       ├── types.ts       # Storage interface
│       ├── sqlite.ts      # SQLite adapter
│       └── codeGenerator.ts  # Code generation utility
├── Dockerfile             # Docker build configuration
├── build.js               # Build script
├── API.md                 # API documentation
└── README.md              # This file
```

### Building

```bash
# Build TypeScript
npm run build

# Run built version
npm start
```

### Docker Build

```bash
# Build the image
docker build -t rondevu .

# Run with volume for persistent storage
docker run -p 3000:3000 -v $(pwd)/data:/app/data rondevu
```

## How It Works

1. **Discover topics** (optional): Call `GET /` to see all active topics and peer counts
2. **Peer A** announces availability by posting to `/:topic/offer` with peer identifier and signaling data
3. Server generates a unique UUID code and stores the session (bucketed by Origin and topic)
4. **Peer B** discovers available peers using `GET /:topic/sessions`
5. **Peer B** filters out their own session using the info field to avoid self-connection
6. **Peer B** selects a peer and posts their connection data to `POST /answer` with the session code
7. Both peers exchange signaling data through `POST /answer` endpoint
8. Both peers poll for updates using `POST /poll` to retrieve connection information
9. Sessions automatically expire after the configured timeout

This allows peers in distributed systems to discover each other without requiring a centralized registry, while maintaining isolation between different applications through Origin headers.

### Origin Isolation

Sessions are isolated by the HTTP `Origin` header, ensuring that:
- Peers can only see sessions from their own origin
- Session codes cannot be accessed cross-origin
- Topics are organized by application domain

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
