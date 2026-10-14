/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BUILTIN_SECRET_PATTERNS, scanText } from '../../shared/dlp.js';
import { checkMcp, type IDlpPattern, type IEffectivePolicy, parseMcpToolName } from '../../shared/policy.js';

/**
 * Policy applied to the request body itself, server-side, whatever the client: the gateway sees
 * every tool the model is offered and every byte of context, so these hold even for a modified
 * client. Tools for blocked MCP servers, shell and web are removed (or the request refused), secrets
 * are redacted, and output is capped.
 */
export type Endpoint = 'messages' | 'chat' | 'responses';

export interface IInspection {
	readonly body: Record<string, unknown>;
	readonly strippedTools: readonly string[];
	readonly dlpFindings: number;
	readonly blocked?: string;
}

type Json = Record<string, unknown>;

/** Client-defined tool names that run a shell (Claude Code, Codex, Volt, Cursor). */
const SHELL_TOOLS = new Set(['bash', 'bashoutput', 'killshell', 'shell', 'local_shell', 'exec_command', 'run_terminal_cmd', 'terminal', 'run_shell_command', 'job_output', 'job_wait', 'job_stop']);
/** Client-defined tool names that reach the web. */
const WEB_TOOLS = new Set(['webfetch', 'websearch', 'web_fetch', 'web_search', 'fetch_url', 'google_web_search']);
/** Provider-hosted (server) tool types. */
const SERVER_WEB = /^(?:web_search|web_fetch|web_search_preview)/;
const SERVER_SHELL = /^(?:bash|local_shell|code_interpreter|code_execution|computer)/;

function toolName(endpoint: Endpoint, tool: Json): string | undefined {
	if (endpoint === 'chat') {
		const fn = tool.function as Json | undefined;
		return typeof fn?.name === 'string' ? fn.name : undefined;
	}
	return typeof tool.name === 'string' ? tool.name : undefined;
}

interface IToolVerdict {
	readonly keep: boolean;
	readonly label: string;
}

function judgeTool(endpoint: Endpoint, tool: Json, policy: IEffectivePolicy, knownServers: readonly string[]): IToolVerdict {
	const type = typeof tool.type === 'string' ? tool.type : '';
	// OpenAI Responses' hosted MCP tool: the whole server is in one entry.
	if (endpoint === 'responses' && type === 'mcp') {
		const server = String(tool.server_label ?? '');
		return { keep: checkMcp(policy, server).allowed, label: `mcp:${server}` };
	}
	if (type && type !== 'function' && type !== 'custom') {
		if (SERVER_WEB.test(type)) {
			return { keep: policy.capabilities.webAccess, label: type };
		}
		if (SERVER_SHELL.test(type)) {
			return { keep: policy.capabilities.shell, label: type };
		}
	}
	const name = toolName(endpoint, tool);
	if (!name) {
		return { keep: true, label: type || 'tool' };
	}
	const mcp = parseMcpToolName(name, knownServers);
	if (mcp) {
		return { keep: checkMcp(policy, mcp.server, mcp.tool).allowed, label: name };
	}
	const lower = name.toLowerCase();
	if (SHELL_TOOLS.has(lower)) {
		return { keep: policy.capabilities.shell, label: name };
	}
	if (WEB_TOOLS.has(lower)) {
		return { keep: policy.capabilities.webAccess, label: name };
	}
	return { keep: true, label: name };
}

/** Keys whose string values are identifiers or binary, never prose to scan. */
const SKIP_KEYS = new Set(['id', 'type', 'role', 'name', 'model', 'tool_use_id', 'call_id', 'signature', 'data', 'media_type', 'cache_control', 'image_url', 'file_id', 'encrypted_content', 'status']);

function redactDeep(value: unknown, patterns: readonly IDlpPattern[], tally: { count: number; blocked: boolean }, key?: string): unknown {
	if (typeof value === 'string') {
		if ((key && SKIP_KEYS.has(key)) || value.startsWith('data:') || value.length < 8) {
			return value;
		}
		const result = scanText(value, patterns);
		for (const f of result.findings) {
			tally.count += f.count;
		}
		tally.blocked ||= result.blocked;
		return result.text;
	}
	if (Array.isArray(value)) {
		return value.map(item => redactDeep(item, patterns, tally));
	}
	if (value && typeof value === 'object') {
		const obj = value as Json;
		// Signed reasoning must stay byte-identical or the provider rejects the conversation.
		if (obj.type === 'thinking' || obj.type === 'redacted_thinking' || obj.type === 'reasoning') {
			return value;
		}
		const out: Json = {};
		for (const [k, v] of Object.entries(obj)) {
			out[k] = redactDeep(v, patterns, tally, k);
		}
		return out;
	}
	return value;
}

const CONTEXT_KEYS: Record<Endpoint, readonly string[]> = {
	messages: ['system', 'messages'],
	chat: ['messages'],
	responses: ['instructions', 'input'],
};

const OUTPUT_KEYS: Record<Endpoint, readonly string[]> = {
	messages: ['max_tokens'],
	chat: ['max_completion_tokens', 'max_tokens'],
	responses: ['max_output_tokens'],
};

export function inspectRequest(endpoint: Endpoint, input: Json, policy: IEffectivePolicy, knownServers: readonly string[]): IInspection {
	const body: Json = { ...input };
	const stripped: string[] = [];

	if (Array.isArray(body.tools)) {
		const kept: unknown[] = [];
		for (const tool of body.tools as Json[]) {
			const verdict = judgeTool(endpoint, tool, policy, knownServers);
			if (verdict.keep) {
				kept.push(tool);
			} else {
				stripped.push(verdict.label);
			}
		}
		if (stripped.length && policy.mcp.enforcement === 'block' && stripped.some(s => s.startsWith('mcp'))) {
			return { body, strippedTools: stripped, dlpFindings: 0, blocked: `Request offers blocked tools: ${stripped.join(', ')}` };
		}
		body.tools = kept;
		if (!kept.length) {
			delete body.tools;
			delete body.tool_choice;
			delete body.parallel_tool_calls;
		} else if (stripped.length && body.tool_choice && typeof body.tool_choice === 'object') {
			const choice = body.tool_choice as Json;
			const named = typeof choice.name === 'string' ? choice.name : typeof (choice.function as Json | undefined)?.name === 'string' ? String((choice.function as Json).name) : undefined;
			if (named && stripped.includes(named)) {
				body.tool_choice = endpoint === 'messages' ? { type: 'auto' } : 'auto';
			}
		}
	}

	// Anthropic's MCP connector names remote servers in the request.
	if (endpoint === 'messages' && Array.isArray(body.mcp_servers)) {
		const servers = body.mcp_servers as Json[];
		const kept = servers.filter(server => {
			const allowed = checkMcp(policy, String(server.name ?? '')).allowed;
			if (!allowed) {
				stripped.push(`mcp:${String(server.name ?? '')}`);
			}
			return allowed;
		});
		if (kept.length !== servers.length && policy.mcp.enforcement === 'block') {
			return { body, strippedTools: stripped, dlpFindings: 0, blocked: 'Request connects blocked MCP servers' };
		}
		body.mcp_servers = kept;
	}

	let dlpFindings = 0;
	const patterns = [...(policy.data.redactSecrets ? BUILTIN_SECRET_PATTERNS : []), ...policy.data.dlpPatterns];
	if (patterns.length) {
		const tally = { count: 0, blocked: false };
		for (const key of CONTEXT_KEYS[endpoint]) {
			if (key in body) {
				body[key] = redactDeep(body[key], patterns, tally, key === 'input' || key === 'instructions' || key === 'system' ? undefined : key);
			}
		}
		dlpFindings = tally.count;
		if (tally.blocked) {
			return { body, strippedTools: stripped, dlpFindings, blocked: 'The request contains data your organization does not allow to leave (DLP)' };
		}
	}

	const cap = policy.limits.maxOutputTokens;
	if (cap) {
		for (const key of OUTPUT_KEYS[endpoint]) {
			if (typeof body[key] === 'number' && (body[key] as number) > cap) {
				body[key] = cap;
			}
		}
		if (endpoint === 'messages' && typeof body.max_tokens !== 'number') {
			body.max_tokens = cap;
		}
		// Extended thinking must stay under max_tokens.
		const thinking = body.thinking as Json | undefined;
		if (endpoint === 'messages' && thinking && typeof thinking.budget_tokens === 'number' && typeof body.max_tokens === 'number' && thinking.budget_tokens >= body.max_tokens) {
			body.thinking = body.max_tokens > 1024 ? { ...thinking, budget_tokens: Math.max(1024, (body.max_tokens as number) - 1024) } : { type: 'disabled' };
		}
	}

	return { body, strippedTools: stripped, dlpFindings };
}
