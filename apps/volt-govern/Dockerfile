# Volt Govern: one Node process serving the console, the admin API and the model gateway.
#
# Build from apps/ (the console imports ../client-core):
#   docker build -f volt-govern/Dockerfile -t volt-govern .
# Run (Postgres recommended; without DATABASE_URL it keeps a SQLite file in the /data volume):
#   docker run -p 4318:4318 --env-file volt-govern/.env -e BETTER_AUTH_URL=https://govern.example.com -v govern-data:/data volt-govern

FROM node:24-slim AS build
WORKDIR /src/volt-govern
COPY volt-govern/package.json volt-govern/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client-core /src/client-core
COPY volt-govern ./
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production PORT=4318 SQLITE_PATH=/data/volt-govern.db
WORKDIR /app
COPY --from=build /src/volt-govern/package.json /src/volt-govern/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force && mkdir -p /data && chown node:node /data
COPY --from=build /src/volt-govern/dist ./dist
USER node
VOLUME /data
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4318) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/server/server/main.js"]
