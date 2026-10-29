FROM node:22-alpine

LABEL org.opencontainers.image.title="PrintBuster" \
      org.opencontainers.image.description="Compare Design Hub print reservations with Bambu Cloud print jobs" \
      org.opencontainers.image.source="https://github.com/vinnesttree/PrintBuster"

# Inside a container the app must listen on all interfaces to be reachable
# through a published port. Choose who can reach it with `-p` / compose ports.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# data/ holds the saved Bambu sign-in token, the print log, the saved
# reservations and the calculated usage; mount a volume here to keep them.
RUN mkdir -p data && chown node:node data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "src/server.js"]
