// Track B capture, base-URL edition (ADEMark's capture is a mitmproxy addon with a trusted CA; in this account we
// point the agent's ANTHROPIC_BASE_URL here instead). Forwards every request to https://api.anthropic.com unchanged and
// logs, per request: host time, path, the request body (auth headers never logged), the User-Agent and the usage the
// API returned (message_start and message_delta of the SSE stream, or the JSON body).
//   bun capture.ts --port 18961 --log <file.jsonl>
import { appendFileSync } from "node:fs";
import { nowNs } from "/tmp/ademark/bench/core/clock.ts";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const PORT = Number(arg("--port", "18961"));
const LOG = arg("--log", "/tmp/v3-ade-capture/capture.jsonl");
const UPSTREAM = "https://api.anthropic.com";

function usageFromSse(text: string): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const ev = JSON.parse(line.slice(5));
      const u = ev.type === "message_start" ? ev.message?.usage : ev.type === "message_delta" ? ev.usage : undefined;
      if (u) for (const [k, v] of Object.entries(u)) if (typeof v === "number") usage[k] = v;
      if (ev.type === "message_start" && ev.message?.model) usage.__model = ev.message.model;
    } catch { /* partial line */ }
  }
  return usage;
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    const t_ns = Number(nowNs());
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, { method: req.method, headers, body, redirect: "manual" });
    const text = await upstream.text();
    let usage: Record<string, unknown> = {};
    if ((upstream.headers.get("content-type") ?? "").includes("event-stream")) usage = usageFromSse(text);
    else { try { const j = JSON.parse(text); usage = { ...(j.usage ?? {}), ...(j.input_tokens !== undefined ? { input_tokens: j.input_tokens } : {}), __model: j.model }; } catch { /* */ } }
    const bodyText = body ? new TextDecoder().decode(body) : "";
    let parsed: unknown = undefined;
    try { parsed = bodyText ? JSON.parse(bodyText) : undefined; } catch { parsed = bodyText; }
    appendFileSync(LOG, JSON.stringify({ t_ns, path: url.pathname, status: upstream.status, user_agent: req.headers.get("user-agent"), bytes: bodyText.length, usage, body: parsed }) + "\n");
    const out = new Headers(upstream.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(text, { status: upstream.status, headers: out });
  },
});
console.log(`capture on http://127.0.0.1:${PORT} -> ${UPSTREAM}, log ${LOG}`);
