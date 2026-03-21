# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer-cached when source hasn't changed)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies so only production deps are copied to the final image
RUN npm prune --omit=dev

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Non-root user for security
RUN addgroup -S mcp && adduser -S mcp -G mcp
WORKDIR /app

# Copy only what is needed to run
COPY --from=builder --chown=mcp:mcp /app/dist ./dist
COPY --from=builder --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=builder --chown=mcp:mcp /app/package.json ./

USER mcp

# MCP_PORT must be set to activate HTTP mode (required for Docker deployment).
# All OPENEMR_* and optional backend env vars are injected at runtime via
# docker-compose or a secrets manager.
ENV MCP_PORT=3100 \
    NODE_ENV=production

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3100/health || exit 1

CMD ["node", "dist/index.js"]
