FROM node:20-alpine

LABEL maintainer="suman99pro"
LABEL description="LinuxBackup — Powerful Backup & Restore Engine"

# Install system tools: tar, rsync, gzip, dd (from coreutils), lsblk (util-linux), partclone
RUN apk add --no-cache \
    bash \
    rsync \
    tar \
    gzip \
    bzip2 \
    xz \
    coreutils \
    util-linux \
    util-linux-misc \
    lsblk \
    pv \
    procps \
    findutils \
    shadow \
    su-exec \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copy package files
COPY backend/package*.json ./

# Install Node dependencies
RUN npm install --production

# Copy backend source
COPY backend/ ./

# Copy frontend
COPY frontend/ ../frontend/

# Create data directories
RUN mkdir -p /data/backups /data/restores /data/logs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

# Start server
CMD ["node", "server.js"]
