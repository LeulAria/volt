#!/bin/sh
# Writes a throwaway Claude Code config dir with the live login's ACCESS token only (no refresh token,
# so nothing here can rotate the user's login). Re-run before each block: the token lives ~1-8 h.
d=${1:-/tmp/v3-tokens/cfg}
mkdir -p "$d"; chmod 700 "$d"
security find-generic-password -s "Claude Code-credentials" -w | python3 -c "
import json,sys; d=json.load(sys.stdin); o=d['claudeAiOauth']
o={k:o[k] for k in ('accessToken','expiresAt','scopes','subscriptionType','rateLimitTier') if k in o}
json.dump({'claudeAiOauth':o}, open('$d/.credentials.json','w'))"
chmod 600 "$d/.credentials.json"
[ -f "$d/.claude.json" ] || echo '{"hasCompletedOnboarding":true,"theme":"dark"}' > "$d/.claude.json"
# CLEAN=1: an account with no claude.ai connectors, synced skills or plugins (like ADEMark's fresh `ademark` user).
if [ "${CLEAN:-0}" = 1 ]; then
  echo '{"disableClaudeAiConnectors":true,"syncClaudeAiSkills":false,"syncClaudeAiPlugins":false}' > "$d/settings.json"
fi
