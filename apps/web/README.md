# volt-web

Volt in the browser: follow, steer and approve the agents running on your computer. The Volt agent
server serves the built app (`out-volt-web` at the repository root) on the same port as its
WebSocket, so the page is always same-origin with the server it talks to.

```sh
npm install
npm run build        # → ../../out-volt-web (packaged builds include it)
npm run typecheck
VOLT_SERVER=http://127.0.0.1:<port> npm run dev   # proxies the server's routes for development
```

Signing in:

- On the computer Volt runs on, the page signs itself in over loopback (`POST /api/auth/local`).
  In Volt, run **Volt: Open Volt in the Browser**.
- From another device, open the pairing link or enter the code from **Settings › Devices** (or
  **Volt: Pair a Phone or Browser…** in Volt). The code is spent once for a device token.

Everything protocol-related (connection, pairing, state, markdown) lives in `../client-core`,
shared with the phone app.
