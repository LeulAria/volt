# Volt end-to-end review (2026-11-12), parallel chat

This folder is the review written by the first chat that took this request ("So in this branch i
want you to merge main…"). Its agents worked on branches `e2e/orch`, `e2e/ide` and `e2e/sbx`, which
are merged into this branch. The index one level up ([../README.md](../README.md)) combines both
reviews.

Branch `feat/orch-and-devenv-revamp`. Each report follows the same layout: summary, how it was
tested, results before, problems found, fixes, results after, what is still open.

| # | Report | Scope |
|---|---|---|
| 00 | [Merging the open PRs](00-merge.md) | main, #92, #93, #94, #95 into this branch; #81 (draft) skipped |
| 01 | [Orchestrator and agent-to-agent](01-orchestrator.md) | spin-up and wake latency, tokens, reliability, live multi-agent tasks, other harnesses |
| 02 | [Code intelligence and IDE tooling](02-code-intelligence.md) | index/LSP bench, agent A/B with and without Volt's tools, debug/docker/db/http/profiler use |
| 03 | [Sandbox and extensions](03-sandbox-and-extensions.md) | adversarial suite, sandbox × feature matrix, first-party extensions, sample extension with mock malicious behavior |

Raw numbers are in `data/<area>/`, screenshots in `img/`, and the scripts that produced them in
`scripts/volt-e2e/<area>/`.
