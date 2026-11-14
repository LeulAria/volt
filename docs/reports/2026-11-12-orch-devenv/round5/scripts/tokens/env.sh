# Round-5 token rig settings (source me). Before = /Users/leularia/Desktop/VOLT/volt-e5-base (9bbb8818c60, read-only), after = volt-e5-tokens.
export TOK_DIR=$HOME/.volt-r5/tokens/run
export TOK_PROXY=http://127.0.0.1:19973
export TOK_CFG=$TOK_DIR/cfg-clean
export TOK_CFG_CREDS=$TOK_CFG/.credentials.json
# Claude Code 2.1.322: the CLI binary inside the agent SDK that Volt's ACP adapter (claude-agent-acp 0.106.0) runs.
export CLAUDE_BIN=$HOME/.npm/_npx/21a32ccb11becb3a/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
unset ELECTRON_RUN_AS_NODE
