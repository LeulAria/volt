# Round-6 token rig settings (source me). Before = /Users/leularia/Desktop/VOLT/volt-e5-base (7f07f73d677, read-only), after = volt-e5-tokens.
export TOK_DIR=$HOME/.volt-r6/tokens/run
export TOK_PROXY=http://127.0.0.1:19973
export TOK_CFG=$TOK_DIR/cfg-clean
export TOK_CFG_CREDS=$TOK_CFG/.credentials.json
# Claude Code 2.1.322: the CLI binary inside the agent SDK that Volt's ACP adapter (claude-agent-acp 0.106.0, global on PATH) runs.
export CLAUDE_BIN=/opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
export ADEMARK_PRICES=$HOME/.volt-r4/ademark/prices/2026-10.json
unset ELECTRON_RUN_AS_NODE
