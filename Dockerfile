# Build stage
FROM node:20-alpine AS builder

# Version is passed as build arg (from git commit hash)
ARG VERSION=unknown

# Install build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including native modules)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY build.js ./
COPY src ./src

# Build TypeScript with version embedded
RUN VERSION=$VERSION npm run build

# Production stage
FROM node:20-alpine

# Install build tools for better-sqlite3 native module
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files and install production deps
COPY package*.json ./
RUN npm ci --omit=dev && \
    npm rebuild better-sqlite3 && \
    npm cache clean --force && \
    apk del python3 make g++

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Copy migrations for schema setup
COPY migrations ./migrations

# Create data directory for SQLite
RUN mkdir -p /app/data && \
    chown -R node:node /app

# Switch to non-root user
USER node

# Environment variables with defaults
ENV PORT=3000
ENV STORAGE_TYPE=sqlite
ENV STORAGE_PATH=/app/data/rondevu.db
ENV CORS_ORIGINS=*
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${PORT}/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start server
CMD ["node", "dist/index.js"]
