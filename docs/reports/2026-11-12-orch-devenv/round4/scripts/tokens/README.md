# Token rig (round 3, ADEMark Track B method, unofficial)

Everything that must survive a reboot lives under `TOK_DIR` (we used `~/.volt-r3/tokens/run`).

1. `TOK_DIR` holds: `arena/` (a copy of ADEMark's `arena/`, `git init`, one commit), `capfx/` (another copy with
   `shop.db` added, for the capability check), `mkcfg.sh` (copied from here).
2. Config dirs: `mkcfg.sh $TOK_DIR/cfg` (the live login's access token only) and `CLEAN=1 mkcfg.sh $TOK_DIR/cfg-clean`
   (also no claude.ai connectors, skill or plugin sync: like ADEMark's fresh `ademark` user). Results use `cfg-clean`.
3. Proxy: `node proxy.mjs 19955 $TOK_DIR/capture.jsonl` (every Anthropic request, usage and body).
4. Test instances (both with `TOK_CFG=$TOK_DIR/cfg-clean`, `ELECTRON_RUN_AS_NODE` unset):
   - after: `VOLT_UD=/tmp/v3-tokens-ud VOLT_CDP=9954 node runtok.mjs launch`
   - base: `VOLT_UD=/tmp/v3-tokens-ud-base VOLT_EXT=/tmp/v3-tokens-ext-base VOLT_CDP=9964 node runtok.mjs launch --checkout <base worktree>`
     (the base worktree is `82ae771c1d9` with `out/` copied from the after worktree and the changed files
     re-transpiled from their base sources with `build/volt/syncOut.mjs`).
5. `[B3_N=3] matrix.sh <tag> <model id> <bare effort> [N]`: B1 "hi" N times (base, after, Bare CLI interleaved), then
   B3 `B3_N` times each (default once), also interleaved. Rows that did not finish get `"invalid": "<why>"` in
   `windows.jsonl` and are left out by every script.
6. `node analyze.mjs $TOK_DIR/capture.jsonl $TOK_DIR/windows.jsonl '<label regex>'`: main thread vs side calls,
   priced from ADEMark's `prices/2026-10.json` (`ADEMARK_PRICES`).
7. `TOK_CFG_CREDS=$TOK_DIR/cfg/.credentials.json node anatomy.mjs <body.json>`: B2 request anatomy via `count_tokens`.
8. `TOK_FOLDER=$TOK_DIR/capfx node capcheck.mjs run [ids]` then `capcheck.mjs report`: one request per volt tool family
   on both builds. `CAP_PREFIX` labels a round (cap, cap2, cap3 in the report), `CAP_ARMS=after` re-checks one build.
9. `r2first.sh [N]` then `firstreq.mjs $TOK_DIR/capture.jsonl $TOK_DIR/windows.jsonl '^r2-'`: first-request size of
   round 2's t0-t3. `traceused.mjs <windows.jsonl> <regex>`: ACP `used` for providers the proxy does not see.
10. `runtok.mjs stop` with each `VOLT_UD` closes the instance and kills its agent server.

Data from the round-3 runs (windows, analyses, anatomies, capability logs, the gzipped capture without bodies) is
in `../../data/tokens/`; the report is `../../23-tokens.md`.
