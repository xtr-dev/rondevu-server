# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY build.js ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create data directory for SQLite
RUN mkdir -p /app/data && \
    chown -R node:node /app

# Switch to non-root user
USER node

# Environment variables with defaults
ENV PORT=3000
ENV STORAGE_TYPE=sqlite
ENV STORAGE_PATH=/app/data/sessions.db
ENV SESSION_TIMEOUT=300000
ENV CODE_CHARS=0123456789
ENV CODE_LENGTH=9
ENV CORS_ORIGINS=*

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${PORT}/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start server
CMD ["node", "dist/index.js"]
