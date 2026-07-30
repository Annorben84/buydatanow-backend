# BuyDataNow API — Node/Express + Mongoose.
#
# There is no build step (plain ESM), so this just installs production deps and
# runs the server. Build from the `backend/` directory:
#   docker build -t buydatanow-api backend
#   docker run --rm -p 5000:5000 --env-file backend/.env buydatanow-api

FROM node:22-alpine AS deps
WORKDIR /app
# Copy manifests only, so `npm ci` is cached until dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# Never run as root.
USER node

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
