#!/bin/zsh
# Round 5 measurement plan after the reboot: four timing-lock sessions (each under 25 min), 3 min apart so other
# agents can take the lock between them. A6 3 reps per arm (before/after), A8 4 reps per arm of before, after and
# nogate (after with the keystroke-first frame gate off), in ABC CBA order.
cd "$(dirname "$0")"
./session.sh before,after 0 '' 2
sleep 180
./session.sh - 1 before,after,nogate,nogate,after,before
sleep 180
./session.sh after,before 0 '' 1
sleep 180
./session.sh - 1 after,nogate,before,before,nogate,after
echo "== all sessions done $(date)"
