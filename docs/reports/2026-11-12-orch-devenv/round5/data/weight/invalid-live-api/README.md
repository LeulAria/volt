Rows from the first two minbefore blocks (2026-11-14 12:02-12:33 UTC, load 30-83). Invalid: the minified build ran its
agent server as a launchd job, which does not inherit ANTHROPIC_BASE_URL, so the seed turns went to the real API
(Haiku 5.5 explored the arena) instead of the replay server, and no seed finished. Kept only as a record; not used.
Fixed in lib.mjs (built arms spawn the agent server with VOLT_AGENT_SERVER_LAUNCHD=0).
