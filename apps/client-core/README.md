# @volt/client-core

The client half of the Volt agent server protocol, shared by `apps/web` and `apps/mobile`. Plain
TypeScript with no runtime dependencies: anything platform specific (WebSocket, storage) is passed in.

- `connection.ts`: one WebSocket at `/ws` with hello/welcome, resume from the last event `seq`,
  hole detection, calls, heartbeat and jittered backoff.
- `environments.ts`: pairing (QR or address + one-time code, `/.well-known/volt/environment`,
  `/api/auth/pair`), saved environments and route ranking (loopback, LAN, Tailscale).
- `client.ts`: `VoltClient`, the state a UI reads (mirrored collections, open transcripts, pending
  sends) and every action it takes (send, steer, stop, approve, answer, pin, archive...).
- `selectors.ts` / `rows.ts`: the chat list sections and the transcript rows both apps draw.
- `markdown/`: an incremental GFM parser (only the tail block is re-parsed while a reply streams)
  and a small syntax highlighter.
- `theme.ts` / `icons.ts`: the design tokens and icon paths the Volt desktop app uses, so web and
  mobile look like it.
