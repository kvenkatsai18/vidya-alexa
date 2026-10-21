# Study Buddy: the MCP server (:8787) and the Alexa+ simulator device page (:5173) in one image.
# Build: docker build -t study-buddy .   Run with deploy/docker-compose.yml (adds HTTPS via Caddy).
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/mcp-server/package.json packages/mcp-server/
COPY apps/simulator/package.json apps/simulator/
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY . .
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    SIM_HOST=0.0.0.0 \
    BUDDY_DATA_DIR=/data
VOLUME /data
EXPOSE 8787 5173
USER node

HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/dev.mjs"]
