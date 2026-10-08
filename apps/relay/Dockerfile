# Volt Relay: no dependencies beyond Node. State lives in /data (mount a volume).
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
RUN ln -s /app/bin/volt-relay.mjs /usr/local/bin/volt-relay && chmod +x bin/*.mjs
ENV VOLT_RELAY_DATA=/data VOLT_RELAY_PORT=8787 NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
CMD ["node", "/app/bin/volt-relay.mjs", "serve"]
