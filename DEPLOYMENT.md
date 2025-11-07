# Deployment Guide

This guide covers deploying Rondevu to various platforms.

## Table of Contents

- [Cloudflare Workers](#cloudflare-workers)
- [Docker](#docker)
- [Node.js](#nodejs)

---

## Cloudflare Workers

Deploy to Cloudflare's edge network using Cloudflare Workers and D1 storage.

### Prerequisites

```bash
npm install -g wrangler
```

### Setup

1. **Login to Cloudflare**
   ```bash
   wrangler login
   ```

2. **Create D1 Database**
   ```bash
   # For production
   npx wrangler d1 create rondevu-sessions

   # This will output:
   # database_name = "rondevu-sessions"
   # database_id = "abc123..."
   ```

3. **Update wrangler.toml**

   Edit `wrangler.toml` and replace the `database_id` with the ID from step 2:

   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "rondevu-sessions"
   database_id = "abc123..."  # Your actual D1 database ID
   ```

4. **Run Database Migration**
   ```bash
   # Run the migration on the remote database
   npx wrangler d1 execute rondevu-sessions --remote --file=./migrations/0001_add_peer_id.sql
   ```

5. **Configure Environment Variables** (Optional)

   Update `wrangler.toml` to customize settings:

   ```toml
   [vars]
   SESSION_TIMEOUT = "300000"  # Session timeout in milliseconds
   CORS_ORIGINS = "https://example.com,https://app.example.com"
   ```

### Local Development

```bash
# Run locally with Wrangler
npx wrangler dev

# The local development server will:
# - Start on http://localhost:8787
# - Use a local D1 database automatically
# - Hot-reload on file changes
```

### Production Deployment

```bash
# Deploy to Cloudflare Workers
npx wrangler deploy

# This will output your worker URL:
# https://rondevu.YOUR_SUBDOMAIN.workers.dev
```

### Custom Domain (Optional)

1. Go to your Cloudflare Workers dashboard
2. Select your worker
3. Click "Triggers" → "Add Custom Domain"
4. Enter your domain (e.g., `api.example.com`)

### Monitoring

View logs and analytics:

```bash
# Stream real-time logs
npx wrangler tail

# View in dashboard
# Visit: https://dash.cloudflare.com → Workers & Pages
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_TIMEOUT` | `300000` | Session timeout in milliseconds |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |

### Pricing

Cloudflare Workers Free Tier includes:
- 100,000 requests/day
- 10ms CPU time per request
- D1: 5 GB storage, 5 million reads/day, 100,000 writes/day

For higher usage, see [Cloudflare Workers pricing](https://workers.cloudflare.com/#plans) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

### Advantages

- **Global Edge Network**: Deploy to 300+ locations worldwide
- **Instant Scaling**: Handles traffic spikes automatically
- **Low Latency**: Runs close to your users
- **No Server Management**: Fully serverless
- **Free Tier**: Generous limits for small projects

---

## Docker

### Quick Start

```bash
# Build
docker build -t rondevu .

# Run with in-memory SQLite
docker run -p 3000:3000 -e STORAGE_PATH=:memory: rondevu

# Run with persistent SQLite
docker run -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e STORAGE_PATH=/app/data/sessions.db \
  rondevu
```

### Docker Compose

Create a `docker-compose.yml`:

```yaml
version: '3.8'

services:
  rondevu:
    build: .
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - STORAGE_TYPE=sqlite
      - STORAGE_PATH=/app/data/sessions.db
      - SESSION_TIMEOUT=300000
      - CORS_ORIGINS=*
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

Run with:
```bash
docker-compose up -d
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `STORAGE_TYPE` | `sqlite` | Storage backend |
| `STORAGE_PATH` | `/app/data/sessions.db` | SQLite database path |
| `SESSION_TIMEOUT` | `300000` | Session timeout in ms |
| `CORS_ORIGINS` | `*` | Allowed CORS origins |

---

## Node.js

### Production Deployment

1. **Install Dependencies**
   ```bash
   npm ci --production
   ```

2. **Build TypeScript**
   ```bash
   npm run build
   ```

3. **Set Environment Variables**
   ```bash
   export PORT=3000
   export STORAGE_TYPE=sqlite
   export STORAGE_PATH=./data/sessions.db
   export SESSION_TIMEOUT=300000
   export CORS_ORIGINS=*
   ```

4. **Run**
   ```bash
   npm start
   ```

### Process Manager (PM2)

For production, use a process manager like PM2:

1. **Install PM2**
   ```bash
   npm install -g pm2
   ```

2. **Create ecosystem.config.js**
   ```javascript
   module.exports = {
     apps: [{
       name: 'rondevu',
       script: './dist/index.js',
       instances: 'max',
       exec_mode: 'cluster',
       env: {
         NODE_ENV: 'production',
         PORT: 3000,
         STORAGE_TYPE: 'sqlite',
         STORAGE_PATH: './data/sessions.db',
         SESSION_TIMEOUT: 300000,
         CORS_ORIGINS: '*'
       }
     }]
   };
   ```

3. **Start with PM2**
   ```bash
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup
   ```

### Systemd Service

Create `/etc/systemd/system/rondevu.service`:

```ini
[Unit]
Description=Rondevu Peer Discovery and Signaling Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/rondevu
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
Environment=PORT=3000
Environment=STORAGE_TYPE=sqlite
Environment=STORAGE_PATH=/opt/rondevu/data/sessions.db
Environment=SESSION_TIMEOUT=300000
Environment=CORS_ORIGINS=*

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable rondevu
sudo systemctl start rondevu
sudo systemctl status rondevu
```

---

## Troubleshooting

### Docker

**Issue: Permission denied on /app/data**
- Ensure volume permissions are correct
- The container runs as user `node` (UID 1000)

**Issue: Database locked**
- Don't share the same SQLite database file across multiple containers
- Use one instance or implement a different storage backend

### Node.js

**Issue: EADDRINUSE**
- Port is already in use, change `PORT` environment variable

**Issue: Database is locked**
- Another process is using the database
- Ensure only one instance is running with the same database file

---

## Performance Tuning

### Node.js/Docker

- Set `SESSION_TIMEOUT` appropriately to balance resource usage
- For high traffic, use `STORAGE_PATH=:memory:` with session replication
- Consider horizontal scaling with a shared database backend

---

## Security Considerations

1. **HTTPS**: Always use HTTPS in production
   - Use a reverse proxy (nginx, Caddy) for Node.js deployments
   - Docker deployments should be behind a reverse proxy

2. **Rate Limiting**: Implement rate limiting at the proxy level

3. **CORS**: Configure CORS origins appropriately
   - Don't use `*` in production
   - Set specific allowed origins: `https://example.com,https://app.example.com`

4. **Input Validation**: SDP offers/answers are stored as-is; validate on client side

5. **Session Codes**: UUID v4 codes provide strong entropy (2^122 combinations)

6. **Origin Isolation**: Sessions are isolated by Origin header to organize topics by domain

---

## Scaling

### Horizontal Scaling

- **Docker/Node.js**: Use a shared database (not SQLite) for multiple instances
  - Implement a Redis or PostgreSQL storage adapter

### Vertical Scaling

- Increase `SESSION_TIMEOUT` or cleanup frequency as needed
- Monitor database size and connection pool
- For Node.js, monitor memory usage and increase if needed
