# Token rig (round 4, ADEMark Track B method, unofficial)

Round 3's rig with round-4 ports and profiles, plus four scripts. Settings: `source env.sh` (`TOK_DIR` =
`~/.volt-r4/tokens/run`, proxy `http://127.0.0.1:19943`, config dir `cfg-clean`).

1. `TOK_DIR` holds `arena/` and `capfx/` (copied from round 3's), `skillfx/` (an arena copy with one uncommitted
   change, for the code-review skill task) and `mkcfg.sh`. Config dirs: `mkcfg.sh $TOK_DIR/cfg`,
   `CLEAN=1 mkcfg.sh $TOK_DIR/cfg-clean` (results use `cfg-clean`).
2. Proxy: `node proxy.mjs 19943 $TOK_DIR/capture.jsonl`. A second one for side experiments (`skillcap.mjs`):
   `node proxy.mjs 19953 ~/.volt-r4/tokens/exp/capture.jsonl`, so they never land in a matrix window.
3. Test instances (`TOK_MODEL=agent:seed-claude-code:claude-opus-5-5`):
   - after: `VOLT_UD=/tmp/v4-tokens-ud VOLT_EXT=/tmp/v4-tokens-ext VOLT_CDP=9943 node runtok.mjs launch`
   - base: `VOLT_UD=/tmp/v4-tokens-ud-base VOLT_EXT=/tmp/v4-tokens-ext-base VOLT_CDP=9947 node runtok.mjs launch --checkout /Users/leularia/Desktop/VOLT/volt-e4-base`
     (the shared read-only before tree at `b2db4e7f605`; only run, never built).
4. `[TOK_ACCESS=full] [B3_N=3] matrix.sh <tag> claude-opus-5-5 high 3`: B1 then B3, base / after / Bare CLI
   interleaved. `matrix.sh` now passes `TOK_PROXY` through `cleanenv.sh` (round 3's default port was baked in,
   so the bare arm went around the proxy when the port changed).
5. `node analyze.mjs $TOK_DIR/capture.jsonl $TOK_DIR/windows.jsonl '<label regex>' [--rows]` with
   `ADEMARK_PRICES=~/.volt-r4/ademark/prices/2026-10.json`.
6. `node b2.mjs <body.json> [prompt]`: ADEMark B2 exactly as `bench/tracks/b/b2-request-anatomy.ts` splits and
   counts it (system, tools, mcp-tools, injected, params). `anatomy.mjs` is round 3's finer split.
7. `node lazycheck.mjs run all <model ref> [reps]` then `lazycheck.mjs report '^lazy-'`: one task per lazy tool
   (Agent twice, Workflow, ScheduleWakeup, ReportFindings, ListAgents) on both builds; "used" and the time from
   the request whose answer calls ToolSearch to the next request. `CAP_PREFIX` labels a round.
8. `node skillcap.mjs <out.jsonl> default,400,250 [reps]`: `claude -p` per skill task and listing cap, through the
   side proxy; "used" = a Skill call naming the expected skill.
9. `node prefixdiff.mjs a.json b.json`: where two captured bodies stop sharing a prompt-cache prefix.
10. `runtok.mjs stop` with each `VOLT_UD` closes an instance and kills its agent server.

`capcheck.mjs`, `r2first.sh`, `firstreq.mjs`, `batch.sh` and `traceused.mjs` are round 3's, unchanged (they still
name round 3's ports and profiles) and were not run in round 4.

Data: `../../data/tokens/` (windows, analyses, B2 and anatomy counts, lazy-tool and skill checks, the capture
without bodies). Bodies are not committed: they carry the account's e-mail (Claude Code's own context).
