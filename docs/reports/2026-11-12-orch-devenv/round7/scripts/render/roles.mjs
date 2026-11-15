// Process roles of a Volt test instance, by command line (shared by a5.mjs and a9.mjs).
export function role(cmd) {
	if (/volt-agent-server-main/.test(cmd)) { return 'agent server'; }
	if (/voltPlugins\/node/.test(cmd)) { return 'plugin host (Memory)'; }
	if (/--type=renderer/.test(cmd)) { return 'renderer'; }
	if (/--type=gpu-process/.test(cmd)) { return 'gpu'; }
	if (/network\.mojom/.test(cmd)) { return 'network service'; }
	if (/--utility-sub-type=node\.mojom\.NodeService/.test(cmd)) {
		if (/Helper \(Plugin\)/.test(cmd) || /extensionHost/.test(cmd)) { return 'extension host'; }
		return 'node utility (shared process/file watcher/pty)';
	}
	if (/--type=utility/.test(cmd)) { return 'utility (other)'; }
	// The CLI first: the global adapter's CLI lives under .../claude-agent-acp/node_modules/.../claude.
	if (/claude-agent-sdk[^ ]*\/claude( |$)|\/claude( |$)/.test(cmd)) { return 'claude CLI'; }
	if (/claude-agent-acp/.test(cmd) && /node/.test(cmd)) { return 'ACP adapter (node)'; }
	if (/codex-acp|\/codex( |$)/.test(cmd)) { return 'codex'; }
	if (/^npm exec|\bnpm exec\b/.test(cmd)) { return 'npm exec wrapper'; }
	if (/volt-sandbox-helper/.test(cmd)) { return 'sandbox helper'; }
	if (/log stream/.test(cmd)) { return 'log stream (sandbox denials)'; }
	if (/volt-sandbox-watchdog/.test(cmd)) { return 'sandbox watchdog sh'; }
	if (/MacOS\/(Electron|VOLT)/.test(cmd) && !/--type=/.test(cmd)) { return 'main'; }
	if (/gopls|tsserver|typescript|language/i.test(cmd)) { return 'language server'; }
	if (/voltCodeIndex|codeIndex/.test(cmd)) { return 'code index'; }
	return 'other: ' + cmd.split(' ')[0].split('/').pop();
}
