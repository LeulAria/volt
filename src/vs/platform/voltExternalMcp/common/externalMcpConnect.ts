/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** One way to connect an agent: the command or config to paste, and what to do after. */
export interface IConnectSnippet {
	readonly id: 'claude' | 'codex' | 'cursor' | 'connector' | 'tunnel';
	readonly title: string;
	readonly code: string;
	readonly note: string;
}

/**
 * Copy-paste setup for the agents people use, all pointing at `url` (the loopback MCP URL). Each
 * signs in with OAuth on its first call; Volt then shows the consent screen.
 */
export function connectSnippets(url: string, options: { readonly name?: string; readonly port: number; readonly publicMcpUrl?: string }): IConnectSnippet[] {
	const name = options.name ?? 'volt';
	const snippets: IConnectSnippet[] = [
		{
			id: 'claude',
			title: 'Claude Code',
			code: `claude mcp add --transport http --scope user ${name} ${url}\nclaude mcp login ${name}`,
			note: 'Or run /mcp in Claude Code and choose Authenticate.',
		},
		{
			id: 'codex',
			title: 'Codex CLI',
			code: `codex mcp add ${name} --url ${url}\ncodex mcp login ${name}`,
			note: 'Codex keeps the server in ~/.codex/config.toml.',
		},
		{
			id: 'cursor',
			title: 'Cursor',
			code: JSON.stringify({ mcpServers: { [name]: { url } } }, null, 2),
			note: 'Add to ~/.cursor/mcp.json, then click Connect next to it in Cursor Settings > MCP.',
		},
	];
	snippets.push(options.publicMcpUrl
		? {
			id: 'connector',
			title: 'ChatGPT and Claude connectors',
			code: options.publicMcpUrl,
			note: 'Add it as a custom connector (remote MCP server). Keep the tunnel running while you use it.',
		}
		: {
			id: 'tunnel',
			title: 'ChatGPT and Claude connectors (through a tunnel)',
			code: `cloudflared tunnel --url http://127.0.0.1:${options.port}`,
			note: 'They run in the cloud and cannot reach this computer. Start a tunnel, paste its https address under Public address, then add <address>/mcp as a custom connector. Anyone with the address can ask to connect; each still needs your approval in Volt.',
		});
	return snippets;
}
