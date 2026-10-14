# Volt Govern

The enterprise control plane between developers and AI providers. A company runs Volt Govern; its developers use Volt. Provider keys stay on the server, every model request goes through Govern's gateway, and admins decide — per organization, team or person — which models, tools, MCP servers, skills and data are allowed, and what it may cost.

Three parts, one Node process:

| Part | Path | What it does |
| --- | --- | --- |
| Console | `src/web` | Admin workbench in Volt's look (VS Code 1.105 restyled: Volt Dark/Light, Geist Mono, Volt's activity bar, menus, buttons and settings rows). People, teams, roles, SSO/SCIM, provider keys, policies, MCP registry, skills, usage, audit, devices, settings, and a gateway playground. |
| API | `src/server/api` | Organization-scoped admin API (`/api/govern/*`), permission-checked per role, every write audited. |
| Gateway | `src/server/gateway` | Anthropic- and OpenAI-compatible endpoints Volt points at. Enforces policy on each request, forwards with the organization's key, meters usage. |
| Volt endpoints | `src/server/volt` | Device sign-in, device registration, gateway credentials, signed policy bundle, skills, MCP requests, activity events. |

Identity is [Better Auth](https://better-auth.com) 1.7: email/password, organizations with teams and custom roles, SSO (OIDC and SAML, DNS-verified domains), SCIM 2.0 provisioning, and the OAuth device authorization grant for Volt desktop.

## Run it

```bash
cd apps/volt-govern
npm install
cp .env.example .env        # set the three secrets (openssl rand -base64 32)
npm run dev                 # server on :4318, console on http://localhost:5179
```

Without `DATABASE_URL` it uses a SQLite file (`node:sqlite`, no native build). Production:

```bash
npm run build
DATABASE_URL=postgres://… NODE_ENV=production npm start   # serves the console and the API on $PORT
```

Migrations run at startup (Better Auth's tables, then `gov_*`), before the auth instance is created. `npm run migrate` runs them alone.

### Docker

```bash
cd apps                                   # the console imports ../client-core
docker build -f volt-govern/Dockerfile -t volt-govern .
docker run -p 4318:4318 --env-file volt-govern/.env \
  -e BETTER_AUTH_URL=https://govern.example.com -e DATABASE_URL=postgres://… volt-govern
```

The image runs as `node`, keeps a SQLite file in the `/data` volume when `DATABASE_URL` is unset, checks `/healthz`, and on `SIGTERM` finishes in-flight requests (gateway streams included) before closing the database.

## How "only through Volt" works

A provider key can't be Volt-only once it is on a laptop, so it never gets there:

1. **Sign-in.** Volt starts the device authorization grant (`/api/auth/device/code`, client id `volt-desktop`) and shows a code; the developer approves it at `/device` (through SSO when configured). Volt gets a session token.
2. **Device key.** Volt generates a P-256 (or Ed25519) key pair, keeps the private key in the OS keychain, and registers the public key (`POST /api/volt/devices`) with a DPoP proof signed by it.
3. **Gateway credential.** `POST /api/volt/token` (session + DPoP) returns a `vgt_…` token: Ed25519-signed by the server, 15 minutes by default, bound to the device key (`cnf.jkt`).
4. **Every request** carries the token and a fresh [DPoP](https://www.rfc-editor.org/rfc/rfc9449) proof (method, path, time, nonce, token hash) signed by the device key. A copied token without the key is refused; a replayed proof is refused; a revoked device or removed member is refused at once.

Volt is open source, so a client check proves nothing: the gateway is the wall. What it enforces holds for any client.

### Enforcement points

| Rule | Where | Holds against a modified client |
| --- | --- | --- |
| Allowed / blocked models, budgets, rate limits, max output tokens | Gateway | Yes |
| MCP servers and tools (`mcp__server__tool` names, OpenAI hosted `mcp` tools, Anthropic `mcp_servers`) | Gateway strips (or refuses) them from each request | Yes |
| Shell and web tools (client tools like `Bash`, provider web search / code execution) | Gateway strips them when disallowed | Yes |
| Secret redaction and DLP patterns | Gateway rewrites the request before it leaves (signed thinking blocks untouched) | Yes |
| Access preset ceiling, blocked paths, local skills, personal accounts, agent list, in-app browser | Volt's access broker, from the signed policy bundle | Needs Volt managed mode (below) |

### Volt client contract (managed mode, next step in the desktop app)

Discovery: `GET /.well-known/volt-govern/configuration` (all endpoint URLs, gateway base URLs, JWKS).

- Native loop: point the Anthropic provider at `<govern>/gateway/anthropic` and OpenAI-compatible providers at `<govern>/gateway/openai/v1`; send the token in `x-api-key` / `Authorization` and a `DPoP` header per request.
- Agent CLIs (Claude Code, Codex): they cannot sign DPoP proofs, so Volt runs a loopback relay (`127.0.0.1:<random>`, per-process secret) that adds the token and proof. Claude Code: `ANTHROPIC_BASE_URL=<relay>`; Codex: a custom model provider `base_url`.
- Policy: `GET /api/volt/policy` returns `{ bundle, signature }` (EdDSA, verify with the JWKS). Refresh it with each token. Map it onto the access broker's policy layers as an `org` layer above project and session.
- Skills: `GET /api/volt/skills/:id`; load into a read-only org skills folder.
- MCP requests: `POST /api/volt/mcp-requests`. Activity: `POST /api/volt/events` (`run`, `tool`, `mcp_call`, `edit`, `access_denied`, `skill_used`, `session`).

## Gateway playground

Insights → Gateway Playground sends prompts through the gateway from the console, as the signed-in admin: their effective policy, rate limit, budgets, request inspection (tools, MCP, DLP), the organization's key, streaming, metering and audit. Use it to check a new key or a policy change before developers hit it; each request shows up in Gateway Requests (client `Volt Govern playground`) and in the audit log (`gateway.playground`).

The console session stands in for a device-bound token, so the playground (`/api/govern/playground/*`) is limited to roles that can update policy (owner, admin, security) and caps output at 4,096 tokens.

## Policies

A policy document attaches to the organization, a team, or one member. A developer's effective policy merges every layer that applies, and a lower layer can only narrow: allow lists intersect, block lists add up, switches can only turn off, limits take the smaller value, the access preset takes the lowest. Budgets are checked per layer against that layer's own month-to-date spend (80% and 100% alerts; optionally block). The MCP registry feeds the organization layer: approved servers are allowed, blocked servers and blocked tools denied. Defaults: auto-accept edits at most, MCP by approval, secrets redacted, no personal accounts.

## Roles

| Role | Can |
| --- | --- |
| Owner | Everything, including deleting the organization |
| Admin | People, teams, keys, policies, identity, settings |
| Security | Policies, MCP approvals, devices, audit log; reads keys and identity |
| Billing | Usage and spend, audit (read only) |
| Curator | Shared skills, rules, prompts and agents |
| Developer | Uses Volt; sees the shared catalog and their own access |

SCIM groups named `volt-admin`, `volt-security`, `volt-billing` or `volt-curator` (case and punctuation tolerant) grant those roles; everyone else is a developer. Deprovisioning removes the member and revokes their devices.

## Security notes

- Provider secrets: AES-256-GCM, key derived per organization (HKDF) from `VOLT_GOVERN_MASTER_KEY`, organization id bound as associated data. Write-only through the API. Rotating the master key means re-sealing credentials (not automated yet).
- The server's Ed25519 signing key is generated on first use, stored sealed, published at `/.well-known/volt-govern/jwks.json`.
- Console writes require JSON and a matching `Origin` (CSRF); device enrolment and token minting accept bearer sessions only, never cookies.
- Tenant isolation: every `gov_*` row has `organization_id`, and every query is scoped by the caller's active organization after a membership check.
- Prompt logging is off by default (metadata only); reading a kept prompt is audited.
- In production (`NODE_ENV=production`) every response carries a strict Content-Security-Policy (scripts only from this origin, no framing), HSTS, `nosniff` and a same-origin resource policy.

## Not done yet

- **Volt desktop managed mode**: the client side of the contract above (device sign-in UI, keychain key, relay, policy → access broker).
- **Email**: invitations log their link and the console shows it to copy; wire SMTP in `authOptions.ts`.
- **Bedrock and Vertex**: they need SigV4 / Google auth; OpenAI-compatible and Anthropic endpoints (including Azure OpenAI with Entra ID client credentials) work today.
- **Horizontal scale**: rate-limit windows, DPoP replay cache and month-to-date spend counters are per process. Use one instance, or move them to Redis.
- **Postgres row-level security** as a second isolation layer, and automated master-key rotation.
- The server has been smoke-tested end to end (sign-up → organization → key → device → DPoP token → gateway stream with MCP stripping, redaction and metering → revocation), and the console exercised in headless Chromium against a mock provider (every editor, the invite dialog, the playground streaming), dark and light. Not yet against real provider keys.
