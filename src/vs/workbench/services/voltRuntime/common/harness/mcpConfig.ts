/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP servers the user already configured for other tools, so native models get the same tools
 * without a second setup: `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor), and
 * `.vscode/mcp.json` (VS Code, `servers` instead of `mcpServers`).
 */

export type McpServerConfig =
	| { readonly name: string; readonly kind: 'stdio'; readonly command: string; readonly args: readonly string[]; readonly env: Record<string, string>; readonly cwd?: string }
	| { readonly name: string; readonly kind: 'http'; readonly url: string; readonly headers: Record<string, string> };

export interface IMcpToolInfo {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: object;
	readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean; readonly title?: string };
}

export function parseMcpConfig(text: string, variables: Record<string, string>): McpServerConfig[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(text));
	} catch {
		return [];
	}
	const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
	const servers = (record.mcpServers ?? record.servers) as Record<string, unknown> | undefined;
	if (!servers || typeof servers !== 'object') {
		return [];
	}
	const out: McpServerConfig[] = [];
	for (const [name, raw] of Object.entries(servers)) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const entry = raw as Record<string, unknown>;
		if (entry.disabled === true) {
			continue;
		}
		const url = typeof entry.url === 'string' ? entry.url : typeof entry.serverUrl === 'string' ? entry.serverUrl : undefined;
		if (url && entry.type !== 'stdio') {
			out.push({ name, kind: 'http', url: substitute(url, variables), headers: stringMap(entry.headers, variables) });
			continue;
		}
		if (typeof entry.command === 'string' && entry.command.trim()) {
			out.push({
				name,
				kind: 'stdio',
				command: substitute(entry.command, variables),
				args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string').map(arg => substitute(arg, variables)) : [],
				env: stringMap(entry.env, variables),
				...(typeof entry.cwd === 'string' ? { cwd: substitute(entry.cwd, variables) } : {}),
			});
		}
	}
	return out;
}

/** `mcp__server__tool`, limited to what every provider accepts as a function name. */
export function mcpToolName(server: string, tool: string): string {
	const clean = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
	const name = `mcp__${clean(server)}__${clean(tool)}`;
	return name.length <= 64 ? name : name.slice(0, 64);
}

/** Schemas from servers are often loose; providers need an object schema at the top. */
export function normalizeMcpSchema(schema: object | undefined): object {
	const record = schema && typeof schema === 'object' ? schema as Record<string, unknown> : {};
	return { ...record, type: 'object', properties: record.properties && typeof record.properties === 'object' ? record.properties : {} };
}

/** MCP `tools/call` content → text (and the first image). */
export function mcpResultContent(result: unknown): { text: string; image?: string; isError: boolean } {
	const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
	const content = Array.isArray(record.content) ? record.content : [];
	const texts: string[] = [];
	let image: string | undefined;
	for (const item of content) {
		const part = item && typeof item === 'object' ? item as Record<string, unknown> : {};
		if (part.type === 'text' && typeof part.text === 'string') {
			texts.push(part.text);
		} else if (part.type === 'image' && typeof part.data === 'string' && !image) {
			image = `data:${typeof part.mimeType === 'string' ? part.mimeType : 'image/png'};base64,${part.data}`;
		} else if (part.type === 'resource' && part.resource && typeof part.resource === 'object') {
			const resource = part.resource as Record<string, unknown>;
			if (typeof resource.text === 'string') {
				texts.push(resource.text);
			}
		}
	}
	if (!texts.length && record.structuredContent !== undefined) {
		texts.push(JSON.stringify(record.structuredContent, undefined, 2));
	}
	return { text: texts.join('\n\n') || (image ? 'Image returned.' : '(no content)'), ...(image ? { image } : {}), isError: record.isError === true };
}

function substitute(value: string, variables: Record<string, string>): string {
	return value.replace(/\$\{([^}]+)\}/g, (whole, key: string) => variables[key.trim()] ?? whole);
}

function stringMap(value: unknown, variables: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	if (value && typeof value === 'object') {
		for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
			if (typeof raw === 'string') {
				out[key] = substitute(raw, variables);
			}
		}
	}
	return out;
}

function stripJsonComments(text: string): string {
	return text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, quoted: string | undefined) => quoted ?? '').replace(/,(\s*[}\]])/g, '$1');
}
