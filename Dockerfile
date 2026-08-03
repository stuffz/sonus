# syntax=docker/dockerfile:1
FROM node:22-slim AS base
WORKDIR /app

# Install dependencies (with patches applied via postinstall)
FROM base AS deps
COPY package.json package-lock.json* ./
COPY patches ./patches
RUN npm ci && npm prune --omit=dev && npm cache clean --force

# Production image
FROM base AS runner
ENV NODE_ENV=production

# Install system dependencies first (cached layer)
# Note: yt-dlp comes bundled with @distube/yt-dlp, we just need ffmpeg and python for it
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy dependencies and source (after apt to preserve cache)
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node package.json ./

# Create logs directory with proper ownership
RUN mkdir -p /app/logs && chown node:node /app/logs

# Run as non-root user for security
USER node

CMD ["npx", "tsx", "src/index.ts"]
