# Volt Sandbox

OS-enforced isolation for anything Volt runs that a stranger, a repository or a model can steer. Today that is agent CLIs and the commands they run; later it will cover MCP servers, extensions and automations.

| Document | What it covers |
|---|---|
| [00-assessment.md](00-assessment.md) | Every execution pathway, the trust boundaries, the threat model, and what the old sandbox got wrong |
| [01-decisions.md](01-decisions.md) | ADRs: bubblewrap, Seatbelt, Windows/MXC, network, policy, capabilities, seccomp, and where we disagreed with the brief |
| [02-design.md](02-design.md) | Architecture, policy schema reference, profiles, layering, capabilities, support matrix, installation, configuration |
| [03-security-findings.md](03-security-findings.md) | What was found and fixed, with the test that covers each |
| [04-performance.md](04-performance.md) | Measured overhead, with the hardware and method |
| [05-limitations.md](05-limitations.md) | What it does not guarantee yet, and the next steps |

**Code:** `src/vs/platform/voltSandbox/`. The pure policy layer is in `common/`; the manager, resolver, proxy and backends are in `node/`.

**Tests:**
- Unit tests: `test/common/`.
- The adversarial suite, real processes against canary files: `test/node/sandboxSecurity.test.ts`. It runs in CI on Linux and macOS as the `Sandbox Security` job, and fails if the sandbox is missing.
- Linux locally: `scripts/volt-sandbox-linux-test.sh` (Docker).

**Tools:**
- `scripts/volt-sandbox-inspect.mjs`: what the sandbox would do here.
- `scripts/volt-sandbox-bench.mjs`: overhead.
