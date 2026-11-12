# 00 · Merging main and the open PRs

## Summary

- `feat/orch-and-devenv-revamp` contains `main` and every open, non-draft PR: #92 (sandbox and plugin
  platform), #93 (agent dev environment), #94 (orchestra), #95 (Supervised as the default access mode).
  #96 is this branch. Draft #81 (`fix/settings-skill-navigation`) is left out, as asked.
- `git rev-list --count HEAD..origin/<branch>` is `0` for `main`, `feat/volt-sandbox`, `feat/orchestra`,
  `feat/agent-dev-environment` and `cursor/supervised-default-access-98bd`. Nothing upstream is missing.
- Type check: **0 errors** (`tsgo`, whole `src/`).
- Unit tests: **15,803 passing, 0 failing, 213 pending** (6 min 36 s, Electron runner, browser and common suites).

## Setup

```sh
git fetch origin
for b in main feat/agent-dev-environment feat/orchestra feat/volt-sandbox cursor/supervised-default-access-98bd; do
  git rev-list --count HEAD..origin/$b      # all 0
done
npx tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck              # exit 0, 0 "error TS"
npm run -s transpile-client-oxc                                             # 4.5 s
unset ELECTRON_RUN_AS_NODE; ./scripts/test.sh --run <orchestration, sandbox, IDE and plugin suites>
```

`scripts/test.sh` loads the whole browser test bundle, so the run covered every suite in the renderer, not only
the files given with `--run`.

## Merge commits on the branch since the installed build (`de2ea41`)

221 commits; 1,851 files changed. The last merges:

| Commit | Merge |
|---|---|
| `e33c552f2fc` | `cursor/supervised-default-access-98bd` (#95) |
| `5f6e819dc98` | `feat/volt-sandbox` (#92) |
| `415e80f71a0` | `feat/orchestra` (#94) |

#93 (`feat/agent-dev-environment`) came in through `feat/orchestra`, which was built on it. #92 brought in the
sandbox's own merge train (C2–C6, P1–P8, M2–M5, PERF-SB).

## Open issues

- None from the merge. The later reports cover the areas themselves.

## After all merges

Later in the pass this branch also took the first chat's `e2e/orch`, `e2e/sbx` and `e2e/ide`
(merges `14b31bc942d`, `bfa7d1d4f37`, `f3e638cc767`) on top of this chat's own fixes. Two conflicts
were resolved:
- **The two Agent Lab samples.** This chat's sample stays at `docs/volt/examples/volt-agent-lab`.
  The first chat's attack-matrix sample moves to `docs/volt/examples/volt-agent-lab-attacks`,
  with its own extension ID.
- **`installSheet.ts`.** It keeps both the pre-install review and the install-time code scan.

Full rerun on the final tree (`npm run -s transpile-client-oxc`, then `./scripts/test.sh`):

- `tsgo`: **0 errors**
- Unit tests: **15,910 passing, 0 failing, 213 pending** (7 min). Before this pass: 15,803 passing.
