FROM node:22-bookworm-slim

# git is required: every ticket gets its own branch and worktree.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public

# State, the cloned repo and the per-ticket worktrees all live here. Mount a volume on it.
ENV DATA_DIR=/data NODE_ENV=production PORT=3000
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Agents run commands as this user, never as root.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/index.js"]
