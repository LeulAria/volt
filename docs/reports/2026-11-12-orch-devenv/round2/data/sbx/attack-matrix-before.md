20:18  up 22:52, 2 users, load averages: 44.02 35.35 22.25
run 1/3 done
run 2/3 done
run 3/3 done
| attack | off | ww-net | ww-nonet | ro-net | ro-nonet | t3 |
|---|---|---|---|---|---|---|
| read ~/.ssh/id_ed25519 | THROUGH 3/3 | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) |
| read ~/.aws/credentials | THROUGH 3/3 | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) |
| read secret env vars | THROUGH 3/3 | blocked | blocked | blocked | blocked | blocked |
| write outside the workspace | THROUGH 3/3 | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) |
| append to ~/.zshrc | THROUGH 3/3 | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) |
| write .git/hooks/pre-commit | THROUGH 3/3 | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) |
| write .vscode/tasks.json | THROUGH 3/3 | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) |
| POST to a host nobody allowed (example.com) | THROUGH 3/3 | THROUGH 3/3 | blocked (seen 3/3) | THROUGH 3/3 | blocked (seen 3/3) | blocked (seen 3/3) |
| connect to a local listener | THROUGH 3/3 | THROUGH 3/3 | blocked | THROUGH 3/3 | blocked | blocked |
| reach the Docker socket | THROUGH 3/3 | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 2/3) | blocked (seen 2/3) | blocked (seen 3/3) |
| spawn sh, the child reads the key | THROUGH 3/3 | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) |
| delayed attack (2 s later, background) | THROUGH 3/3 | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) | blocked (seen 3/3) |
| CONTROL: write a file in the workspace | works | works | works | FAILS 3/3 (seen 3/3) | FAILS 3/3 (seen 3/3) | FAILS 3/3 (seen 3/3) |
20:20  up 22:54, 2 users, load averages: 18.91 29.51 21.58
