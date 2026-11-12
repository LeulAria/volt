/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { capabilityTargetMatches } from './capabilityCatalog.js';
import { CREDENTIAL_HOME_PATHS } from '../../voltSandbox/common/sandboxProfiles.js';

/**
 * Install-time code scan of a third-party extension (spec P4, G.12): what its shipped JavaScript does
 * that its manifest doesn't say, found before the user decides where it runs. A finding is a reason to
 * run the extension in Volt's sandbox, never proof; the sandbox is what blocks it.
 *
 * Two severities, calibrated on 64 real extensions (gitlens, remote-ssh, eslint, prettier, the Java and
 * Azure packs...), where none had a `high` finding and 50 had a `medium` one:
 *
 * `high`, what malware does and ordinary extensions don't:
 * - `hidden-name`: a sensitive name assembled or escaped to hide it (`['child','process'].join('_')`,
 *   `'ev' + 'al'`, a reversed string, `'\x65val'`);
 * - `encoded-payload`: base64 or hex that decodes to a host, a command, a credential path or a hidden name;
 * - `raw-host` to a drop box for stolen data (a request catcher, paste site, chat webhook or tunnel);
 * - `undeclared-api`: a `vscode.volt` call whose capability `contributes.voltCapabilities` doesn't declare.
 *
 * `medium`, what the code can do, common in legitimate extensions too (language servers, git, SSH):
 * - `credential-path`: a credential location (`~/.ssh`, `~/.aws`, a keychain, Volt's own grants), also
 *   built from pieces (`path.join(home, '.ssh', 'id_rsa')`);
 * - `dynamic-code`: `eval`, `new Function`, Node's `vm` (not the `Function('return this')` idiom);
 * - `process-spawn`: `child_process`;
 * - `computed-require`: `require(x)` / `process.getBuiltinModule(x)` with a name computed at runtime;
 * - `raw-host`: a URL to an IP address or `localhost`;
 * - `env-harvest`: the whole environment (`Object.keys(process.env)`, `JSON.stringify(process.env)`);
 * - `native-binding`: `process.binding`, `process.dlopen`.
 */

export type CodeScanRule = 'credential-path' | 'dynamic-code' | 'hidden-name' | 'encoded-payload' | 'process-spawn' | 'computed-require' | 'raw-host' | 'env-harvest' | 'native-binding' | 'undeclared-api';

export type CodeScanSeverity = 'high' | 'medium';

/** The order findings are listed in: what most needs a sandbox first. */
export const CODE_SCAN_RULES: readonly CodeScanRule[] = ['hidden-name', 'encoded-payload', 'raw-host', 'undeclared-api', 'credential-path', 'dynamic-code', 'process-spawn', 'computed-require', 'env-harvest', 'native-binding'];

export interface ICodeScanFinding {
	readonly rule: CodeScanRule;
	readonly severity: CodeScanSeverity;
	/** Relative to the extension's folder, `/`-separated. */
	readonly file: string;
	/** 1-based, of the first occurrence. */
	readonly line: number;
	/** What was found, short and safe to show (`~/.ssh/id_rsa`, `eval`, `a network address: 127.0.0.1`). */
	readonly evidence: string;
	/** Occurrences of this rule and evidence across the extension. */
	readonly count: number;
}

export interface ICodeScanFile {
	/** Relative to the extension's folder, `/`-separated. */
	readonly path: string;
	readonly text: string;
}

export interface ICodeScanOptions {
	/** `contributes.voltCapabilities` `net.connect` targets: URLs to them are not findings. */
	readonly declaredHosts?: readonly string[];
	/**
	 * Every declared capability id (required and optional), for `undeclared-api`. Only for an
	 * extension that turns on the `volt` proposal: elsewhere `x.memory.write(` is someone else's API.
	 */
	readonly declaredCapabilities?: readonly string[];
}

export interface ICodeScanResult {
	/** One per rule and evidence, in {@link CODE_SCAN_RULES} order. */
	readonly findings: readonly ICodeScanFinding[];
	readonly files: number;
	readonly bytes: number;
	/** Files left out by the limits: the scan is partial when this is above 0. */
	readonly skipped: number;
}

/** What one scan reads at most: enough for any real extension's shipped code, bounded for a hostile one. */
export const CODE_SCAN_LIMITS = { files: 1500, bytes: 24 * 1024 * 1024, fileBytes: 6 * 1024 * 1024, depth: 12 } as const;

/** JavaScript an extension host can load. Source maps and type declarations are not code. */
export function isScannableFile(path: string): boolean {
	return /\.(?:c|m)?js$/i.test(path) && !/\.min\.map$/i.test(path);
}

// --- lexing ---------------------------------------------------------------------------------------

interface IStringLiteral {
	readonly start: number;
	readonly end: number;
	/** Unescaped (`\x63` is `c`); a template literal's `${...}` parts are kept as written. */
	readonly value: string;
	/** Written with `\x` or `\u` escapes: a readable name written that way is hiding. */
	readonly escaped: boolean;
}

interface ILexed {
	/** The text with comments blanked (same length, newlines kept). */
	readonly code: string;
	/** `code` with string contents blanked too (quotes kept): for rules about syntax. */
	readonly blank: string;
	readonly strings: readonly IStringLiteral[];
}

/** Where a `/` starts a regular expression rather than a division (the usual heuristic). */
const REGEX_PREFIX = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase|\bdo|\belse|\bin|\bof|\bvoid|\bdelete|\bthrow|\bnew|\byield|\bawait)\s*$/;

function lex(text: string): ILexed {
	const code = text.split('');
	const blank = text.split('');
	const strings: IStringLiteral[] = [];
	const blankOut = (from: number, to: number, both: boolean) => {
		for (let i = from; i < to; i++) {
			if (text[i] !== '\n') {
				blank[i] = ' ';
				if (both) {
					code[i] = ' ';
				}
			}
		}
	};
	// Template literals nest through `${ ... }`: the brace depth at which each one resumes.
	const templates: number[] = [];
	let depth = 0;
	let i = 0;
	const n = text.length;
	const readString = (quote: string, from: number): number => {
		let value = '';
		let escaped = false;
		let j = from + 1;
		while (j < n) {
			const ch = text[j];
			if (ch === '\\') {
				escaped ||= text[j + 1] === 'x' || text[j + 1] === 'u';
				const [decoded, length] = unescapeAt(text, j);
				value += decoded;
				j += length;
				continue;
			}
			if (ch === quote) {
				strings.push({ start: from, end: j + 1, value, escaped });
				blankOut(from + 1, j, false);
				return j + 1;
			}
			if (quote === '`' && ch === '$' && text[j + 1] === '{') {
				// The literal so far; its expression is code.
				strings.push({ start: from, end: j, value: value + '${', escaped });
				blankOut(from + 1, j, false);
				templates.push(depth);
				depth++;
				return j + 2;
			}
			if (ch === '\n' && quote !== '`') {
				return j; // unterminated: stop at the line
			}
			value += ch;
			j++;
		}
		return n;
	};
	while (i < n) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === '/' && next === '/') {
			const end = text.indexOf('\n', i);
			const stop = end < 0 ? n : end;
			blankOut(i, stop, true);
			i = stop;
		} else if (ch === '/' && next === '*') {
			const end = text.indexOf('*/', i + 2);
			const stop = end < 0 ? n : end + 2;
			blankOut(i, stop, true);
			i = stop;
		} else if (ch === '\'' || ch === '"' || ch === '`') {
			i = readString(ch, i);
		} else if (ch === '}' && templates.length && templates[templates.length - 1] === depth - 1) {
			// Back in the template literal after `${ ... }`.
			templates.pop();
			depth--;
			i = readString('`', i);
		} else if (ch === '/' && REGEX_PREFIX.test(text.slice(Math.max(0, i - 12), i))) {
			let j = i + 1;
			let inClass = false;
			while (j < n && text[j] !== '\n') {
				if (text[j] === '\\') {
					j += 2;
					continue;
				}
				if (text[j] === '[') {
					inClass = true;
				} else if (text[j] === ']') {
					inClass = false;
				} else if (text[j] === '/' && !inClass) {
					break;
				}
				j++;
			}
			blankOut(i + 1, j, false);
			i = j + 1;
		} else {
			if (ch === '{') {
				depth++;
			} else if (ch === '}') {
				depth = Math.max(0, depth - 1);
			}
			i++;
		}
	}
	return { code: code.join(''), blank: blank.join(''), strings };
}

/** One escape sequence at `at` (a backslash): its value and length. */
function unescapeAt(text: string, at: number): [string, number] {
	const ch = text[at + 1];
	switch (ch) {
		case 'n': return ['\n', 2];
		case 't': return ['\t', 2];
		case 'r': return ['\r', 2];
		case '0': return ['\0', 2];
		case 'x': {
			const hex = /^[0-9a-fA-F]{2}/.exec(text.slice(at + 2, at + 4));
			return hex ? [String.fromCharCode(parseInt(hex[0], 16)), 4] : ['x', 2];
		}
		case 'u': {
			const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(text.slice(at + 2, at + 10));
			if (braced) {
				return [String.fromCodePoint(Math.min(0x10FFFF, parseInt(braced[1], 16))), 2 + braced[0].length];
			}
			const hex = /^[0-9a-fA-F]{4}/.exec(text.slice(at + 2, at + 6));
			return hex ? [String.fromCharCode(parseInt(hex[0], 16)), 6] : ['u', 2];
		}
		case '\n': return ['', 2];
		case undefined: return ['', 1];
		default: return [ch, 2];
	}
}

// --- rules ------------------------------------------------------------------------------------------

const KEY_FILES = /(?:^|[/\\])(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|known_hosts|authorized_keys|login\.keychain(?:-db)?)$/;
const CREDENTIAL_PATTERNS: readonly { readonly path: string; readonly pattern: RegExp }[] = CREDENTIAL_HOME_PATHS.map(path => ({
	path,
	// At a path boundary: `~/.ssh/id_rsa`, `.ssh`, `/Users/x/.aws/credentials`; not `my.sshd` or `foo.aws`.
	pattern: new RegExp(`(?:^|[/\\\\~])${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[/\\\\])`),
}));

/** Names worth hiding: building one from pieces is the signal. */
const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
	'eval', 'Function', 'constructor', 'require', 'getBuiltinModule', 'mainModule', 'binding', 'dlopen',
	'child_process', 'node:child_process', 'exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork',
	'vm', 'node:vm', 'runInThisContext', 'runInNewContext', 'readFileSync', 'readFile', 'writeFileSync', 'homedir', 'env',
	'.ssh', 'id_rsa', 'id_ed25519', '.aws', 'credentials', '.npmrc', '.netrc', '.gnupg', 'Keychains',
]);

/** Hosts XML and JSON schemas name as identifiers: never connected to. */
const NAMESPACE_HOSTS = /^(?:www\.)?(?:w3\.org|json-schema\.org|schemas\.microsoft\.com|schemas\.openxmlformats\.org|purl\.org|ns\.adobe\.com|xmlns\.com)$/i;

/**
 * Where stolen data is dropped: request catchers, paste sites, chat-bot webhooks, tunnels and
 * out-of-band test hosts. Narrower than the network broker's exfil list (`isExfilHost`), which also
 * holds the APIs and object stores real extensions call (api.github.com, S3, Azure blobs).
 */
const DROP_HOSTS = /(?:^|\.)(?:webhook\.site|requestbin\.(?:com|net)|pipedream\.net|m\.pipedream\.net|hookbin\.com|beeceptor\.com|requestcatcher\.com|pastebin\.com|paste\.ee|hastebin\.com|ghostbin\.\w+|transfer\.sh|file\.io|0x0\.st|ngrok(?:-free)?\.(?:io|app|dev)|trycloudflare\.com|loca\.lt|serveo\.net|interact\.sh|oast\.(?:fun|live|me|online|pro|site)|burpcollaborator\.net|canarytokens\.com|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org)$/i;

/** `vscode.volt` methods and the capability each needs (docs/volt/extension-api.md), for `undeclared-api`. */
const VOLT_API_CAPABILITIES: readonly { readonly pattern: RegExp; readonly capability: string; readonly label: string }[] = [
	{ pattern: /\.chats\s*\.\s*list\s*\(/g, capability: 'agents.read:any', label: 'volt.chats.list' },
	{ pattern: /\.chats\s*\.\s*onDid(?:Start|End)Turn\b/g, capability: 'agents.read:any', label: 'volt.chats turn events' },
	{ pattern: /\.chats\s*\.\s*send\s*\(/g, capability: 'agents.send', label: 'volt.chats.send' },
	{ pattern: /\.chats\s*\.\s*start\s*\(/g, capability: 'agents.create', label: 'volt.chats.start' },
	{ pattern: /\.memory\s*\.\s*(?:write|delete)\s*\(/g, capability: 'agents.context', label: 'volt.memory.write' },
	{ pattern: /\.memory\s*\.\s*(?:list|read)\s*\(/g, capability: 'agents.read:any', label: 'volt.memory.read' },
	{ pattern: /\.browser\s*\.\s*open\s*\(/g, capability: 'browser.drive', label: 'volt.browser.open' },
	{ pattern: /\.browser\s*\.\s*readPage\s*\(/g, capability: 'browser.read', label: 'volt.browser.readPage' },
	{ pattern: /\.automations\s*\.\s*(?:schedule|run|remove)\s*\(/g, capability: 'automations.schedule', label: 'volt.automations.schedule' },
	{ pattern: /\.usage\s*\.\s*(?:get|limits)\s*\(/g, capability: 'usage.report', label: 'volt.usage' },
	{ pattern: /\.pullRequests\s*\.\s*(?:list|link)\s*\(/g, capability: 'hosting.read', label: 'volt.pullRequests' },
	{ pattern: /\.gitGraph\s*\.\s*open\s*\(/g, capability: 'git.read', label: 'volt.gitGraph.open' },
	{ pattern: /\.tools\s*\.\s*invokeTool\s*\(/g, capability: 'agents.send', label: 'volt.tools.invokeTool' },
	{ pattern: /\.visuals\s*\.\s*drawOnScratch\s*\(/g, capability: 'agents.send', label: 'volt.visuals.drawOnScratch' },
];

interface IRawFinding {
	readonly rule: CodeScanRule;
	readonly severity: CodeScanSeverity;
	readonly at: number;
	readonly evidence: string;
}

function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) {
		line++;
	}
	return line;
}

function short(value: string, max = 60): string {
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** The credential location `value` names, if any. A regular expression's source (`^(gpg\\.x|...)`) is not a path. */
function credentialIn(value: string): string | undefined {
	const normalized = value.replace(/\\/g, '/');
	if (normalized.length < 3 || normalized.length > 400 || /[|^$()]/.test(normalized)) {
		return undefined;
	}
	const entry = CREDENTIAL_PATTERNS.find(candidate => candidate.pattern.test(normalized));
	return entry?.path ?? (KEY_FILES.test(normalized) ? normalized.split('/').pop() : undefined);
}

function isSensitive(value: string): boolean {
	return SENSITIVE_NAMES.has(value) || !!credentialIn(value);
}

/** Text that decodes from base64 or hex to readable characters, else undefined. */
function decoded(value: string, encoding: string): string | undefined {
	let text: string;
	try {
		if (encoding === 'hex') {
			if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) {
				return undefined;
			}
			text = value.replace(/../g, pair => String.fromCharCode(parseInt(pair, 16)));
		} else {
			if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length % 4 === 1) {
				return undefined;
			}
			text = globalThis.atob(value.replace(/-/g, '+').replace(/_/g, '/'));
		}
	} catch {
		return undefined;
	}
	const printable = text.replace(/[^\x20-\x7e\t\n\r]/g, '').length;
	return text.length && text.length <= 2048 && printable / text.length >= 0.95 ? text : undefined;
}

/** Decoded text that is worth hiding: a host or URL, a shell command, a credential path or a sensitive name. */
function payloadKind(text: string): string | undefined {
	const trimmed = text.trim();
	if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/.test(trimmed) || /^(?:https?|wss?|ftp):\/\//i.test(trimmed)) {
		return 'a network address';
	}
	if (/\b(?:curl|wget|nc|bash|sh -c|powershell|osascript|chmod \+x)\b/.test(trimmed)) {
		return 'a shell command';
	}
	if (credentialIn(trimmed)) {
		return 'a credential path';
	}
	if (isSensitive(trimmed)) {
		return 'a hidden name';
	}
	return undefined;
}

/**
 * Whether the manifest names `host` for `net.connect`, so a literal of it is no finding. A text
 * match on the declaration, not a permission decision (nothing is granted by it; the Authority
 * judges the calls at runtime). Like the network broker's route manifest, a bare `*` names no host;
 * a drop host (`drop`) counts only when named exactly, never through a wildcard.
 */
function hostDeclared(host: string, declared: readonly string[], drop: boolean): boolean {
	const lower = host.toLowerCase();
	const named = declared.map(pattern => pattern.trim().toLowerCase()).filter(pattern => pattern && pattern !== '*');
	return drop ? named.includes(lower) : named.some(pattern => capabilityTargetMatches(pattern, lower));
}

function scanFile(file: ICodeScanFile, options: ICodeScanOptions): IRawFinding[] {
	const { code, blank, strings } = lex(file.text);
	const found: IRawFinding[] = [];
	const add = (rule: CodeScanRule, severity: CodeScanSeverity, at: number, evidence: string) => found.push({ rule, severity, at, evidence });

	// The text with each string literal as a token `\u0001<index>\u0002`, for rules about how literals combine.
	let tokens = '';
	const tokenAt: number[] = [];
	let cursor = 0;
	strings.forEach((literal, index) => {
		tokens += code.slice(cursor, literal.start);
		tokenAt.push(tokens.length);
		tokens += `\u0001${index}\u0002`;
		cursor = literal.end;
	});
	tokens += code.slice(cursor);
	const literalIndexes = (match: string) => [...match.matchAll(/\u0001(\d+)\u0002/g)].map(m => Number(m[1]));
	const originAt = (tokenOffset: number) => {
		// The source offset of the first literal at or after a token offset.
		const index = tokenAt.findIndex(at => at >= tokenOffset);
		return index >= 0 ? strings[index].start : 0;
	};
	const LIT = '\\u0001\\d+\\u0002';

	// Single literals: credential locations, `child_process`, URLs to raw or exfil hosts.
	const declaredHosts = options.declaredHosts ?? [];
	for (const literal of strings) {
		const value = literal.value;
		if (credentialIn(value)) {
			add('credential-path', 'medium', literal.start, short(value));
		}
		if (value === 'child_process' || value === 'node:child_process') {
			add('process-spawn', 'medium', literal.start, value);
		}
		if (literal.escaped && isSensitive(value)) {
			add('hidden-name', 'high', literal.start, short(value));
		}
		for (const url of value.matchAll(/\b(?:https?|wss?):\/\/([^\s/'"`:?#$\\{}]+)(\/api\/webhooks)?/gi)) {
			const host = url[1].toLowerCase().replace(/^\[|\]$/g, '');
			const drop = DROP_HOSTS.test(`${host}${url[2] ?? ''}`);
			if (NAMESPACE_HOSTS.test(host) || hostDeclared(host, declaredHosts, drop)) {
				continue;
			}
			const raw = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host === 'localhost' || host.includes(':');
			if (raw || drop) {
				add('raw-host', raw ? 'medium' : 'high', literal.start, short(url[0]));
			}
		}
	}

	// Pieces joined into something sensitive: `[...].join(sep)`, `'a' + 'b'`, a reversed string, and
	// path pieces (`join(home, '.ssh', 'id_rsa')`).
	for (const match of tokens.matchAll(new RegExp(`\\[\\s*${LIT}(?:\\s*,\\s*${LIT})+\\s*\\]\\s*\\.\\s*join\\s*\\(\\s*(${LIT})?\\s*\\)`, 'g'))) {
		const indexes = literalIndexes(match[0]);
		const separator = match[1] ? strings[indexes.pop()!].value : ',';
		const joined = indexes.map(index => strings[index].value).join(separator);
		if (isSensitive(joined)) {
			add('hidden-name', 'high', originAt(match.index), short(joined));
		}
	}
	for (const match of tokens.matchAll(new RegExp(`${LIT}(?:\\s*\\+\\s*${LIT})+`, 'g'))) {
		const joined = literalIndexes(match[0]).map(index => strings[index].value).join('');
		if (isSensitive(joined)) {
			// A path in two pieces is ordinary; a name in pieces is hiding it.
			if (credentialIn(joined)) {
				add('credential-path', 'medium', originAt(match.index), short(joined));
			} else {
				add('hidden-name', 'high', originAt(match.index), short(joined));
			}
		}
	}
	for (const match of tokens.matchAll(new RegExp(`(${LIT})\\s*\\.\\s*split\\s*\\(\\s*${LIT}\\s*\\)\\s*\\.\\s*reverse\\s*\\(\\s*\\)`, 'g'))) {
		const reversed = strings[literalIndexes(match[1])[0]].value.split('').reverse().join('');
		if (isSensitive(reversed)) {
			add('hidden-name', 'high', originAt(match.index), short(reversed));
		}
	}
	for (const match of tokens.matchAll(new RegExp(`${LIT}(?:\\s*,\\s*${LIT})+`, 'g'))) {
		const indexes = literalIndexes(match[0]);
		const joined = indexes.map(index => strings[index].value).join('/');
		// Only when no single piece is already a finding.
		if (credentialIn(joined) && !indexes.some(index => credentialIn(strings[index].value))) {
			add('credential-path', 'medium', originAt(match.index), short(joined));
		}
	}

	// Encoded text: `Buffer.from('...', 'base64')`, `atob('...')`.
	for (const match of tokens.matchAll(new RegExp(`\\bBuffer\\s*\\.\\s*from\\s*\\(\\s*(${LIT})\\s*,\\s*(${LIT})|\\batob\\s*\\(\\s*(${LIT})`, 'g'))) {
		const value = strings[literalIndexes(match[1] ?? match[3])[0]].value;
		const encoding = match[2] ? strings[literalIndexes(match[2])[0]].value : 'base64';
		if (encoding !== 'base64' && encoding !== 'base64url' && encoding !== 'hex') {
			continue;
		}
		const text = decoded(value, encoding);
		const kind = text && payloadKind(text);
		if (text && kind) {
			add('encoded-payload', 'high', originAt(match.index), `${kind}: ${short(text, 40)}`);
		}
	}

	// Syntax, with strings and comments blanked.
	for (const match of blank.matchAll(/(?<![\w$.])eval\s*\(/g)) {
		add('dynamic-code', 'medium', match.index, 'eval');
	}
	for (const match of blank.matchAll(/(?:\bnew\s+|(?<![\w$.]))Function\s*\(/g)) {
		// `Function('return this')()`, the global-object idiom of many bundles, is not dynamic code.
		const after = strings.find(literal => literal.start >= match.index + match[0].length && literal.start <= match.index + match[0].length + 2);
		if (after?.value.trim() === 'return this' && !/,/.test(blank.slice(match.index + match[0].length, after.start))) {
			continue;
		}
		add('dynamic-code', 'medium', match.index, match[0].startsWith('new') ? 'new Function' : 'Function');
	}
	for (const match of code.matchAll(/(?:\brequire|\bgetBuiltinModule|\bimport)\s*\(\s*(['"`])(?:node:)?vm\1|\bfrom\s*(['"])(?:node:)?vm\2|\.runIn(?:New|This)?Context\s*\(|\bnew\s+vm\s*\.\s*Script\b/g)) {
		add('dynamic-code', 'medium', match.index, short(match[0].replace(/\s+/g, '').replace(/\($/, ''), 30));
	}
	for (const match of blank.matchAll(/(?<![\w$.])require\s*(?:\.\s*(?:call|apply)\s*)?\(\s*(?![\s'"`)])|\bgetBuiltinModule\s*\(\s*(?![\s'"`)])|\bmodule\s*\.\s*require\s*\(\s*(?![\s'"`)])/g)) {
		add('computed-require', 'medium', match.index, match[0].includes('getBuiltinModule') ? 'process.getBuiltinModule(<computed>)' : 'require(<computed>)');
	}
	for (const match of blank.matchAll(/\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\s*\(/g)) {
		add('native-binding', 'medium', match.index, short(match[0].replace(/\s+/g, '').replace(/\($/, ''), 30));
	}
	for (const match of blank.matchAll(/\bObject\s*\.\s*(?:keys|entries|values)\s*\(\s*process\s*\.\s*env\s*\)|\bJSON\s*\.\s*stringify\s*\(\s*process\s*\.\s*env\b|\bfor\s*\(\s*(?:const|let|var)\s+[\w$]+\s+in\s+process\s*\.\s*env\s*\)/g)) {
		add('env-harvest', 'medium', match.index, short(match[0].replace(/\s+/g, ' '), 40));
	}

	// `vscode.volt` calls beyond the manifest.
	if (options.declaredCapabilities) {
		const declared = new Set(options.declaredCapabilities.map(id => id.replace(/@\d+$/, '')));
		for (const api of VOLT_API_CAPABILITIES) {
			if (declared.has(api.capability)) {
				continue;
			}
			for (const match of blank.matchAll(api.pattern)) {
				add('undeclared-api', 'high', match.index, `${api.label} needs ${api.capability}`);
			}
		}
	}
	return found;
}

/** Collects one scan's findings, file by file. */
class CodeScan {
	private readonly merged = new Map<string, { finding: ICodeScanFinding; count: number }>();
	private bytes = 0;
	private scanned = 0;
	private skipped = 0;

	constructor(private readonly options: ICodeScanOptions) { }

	add(file: ICodeScanFile): void {
		if (!isScannableFile(file.path)) {
			return;
		}
		if (this.scanned >= CODE_SCAN_LIMITS.files || file.text.length > CODE_SCAN_LIMITS.fileBytes || this.bytes + file.text.length > CODE_SCAN_LIMITS.bytes) {
			this.skipped++;
			return;
		}
		this.scanned++;
		this.bytes += file.text.length;
		for (const raw of scanFile(file, this.options)) {
			const key = `${raw.rule}\u0000${raw.evidence}`;
			const existing = this.merged.get(key);
			if (existing) {
				existing.count++;
			} else {
				this.merged.set(key, { finding: { rule: raw.rule, severity: raw.severity, file: file.path, line: lineAt(file.text, raw.at), evidence: raw.evidence, count: 1 }, count: 1 });
			}
		}
	}

	result(skipped = 0): ICodeScanResult {
		const findings = [...this.merged.values()]
			.map(({ finding, count }) => ({ ...finding, count }))
			.sort((a, b) => CODE_SCAN_RULES.indexOf(a.rule) - CODE_SCAN_RULES.indexOf(b.rule) || (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
		return { findings, files: this.scanned, bytes: this.bytes, skipped: this.skipped + skipped };
	}
}

/**
 * Scans an extension's JavaScript. `files` beyond {@link CODE_SCAN_LIMITS} are counted as skipped;
 * findings are merged by rule and evidence (the first place each was seen, and how often).
 */
export function scanExtensionCode(files: readonly ICodeScanFile[], options: ICodeScanOptions = {}): ICodeScanResult {
	const scan = new CodeScan(options);
	files.forEach(file => scan.add(file));
	return scan.result();
}

/**
 * The scan of an extension's folder, file by file with `pause` between files, so a window that
 * scans a 20 MB extension stays responsive (about 100 ms of work per MB).
 */
export async function scanExtensionFolder(root: string, reader: ICodeScanReader, options: ICodeScanOptions, pause: () => Promise<void>): Promise<ICodeScanResult> {
	const { files, skipped } = await readScanFiles(root, reader);
	const scan = new CodeScan(options);
	for (const file of files) {
		scan.add(file);
		await pause();
	}
	return scan.result(skipped);
}

/** From an extension's manifest: its `net.connect` targets and, when it uses `vscode.volt`, every capability id it declares. */
export function codeScanOptionsOf(manifest: { readonly enabledApiProposals?: readonly string[]; readonly contributes?: unknown }): ICodeScanOptions {
	const capabilities = (manifest.contributes as { voltCapabilities?: { required?: unknown; optional?: unknown } } | undefined)?.voltCapabilities;
	const entries = [capabilities?.required, capabilities?.optional].flatMap(list => Array.isArray(list) ? list : []) as { id?: unknown; targets?: unknown }[];
	const ids = entries.map(entry => entry?.id).filter((id): id is string => typeof id === 'string');
	const declaredHosts = entries.filter(entry => typeof entry?.id === 'string' && entry.id.replace(/@\d+$/, '') === 'net.connect' && Array.isArray(entry.targets))
		.flatMap(entry => (entry.targets as unknown[]).filter((target): target is string => typeof target === 'string'));
	const voltApi = Array.isArray(manifest.enabledApiProposals) && manifest.enabledApiProposals.some(proposal => proposal === 'volt' || proposal.startsWith('volt@'));
	return { declaredHosts, ...(voltApi ? { declaredCapabilities: ids } : {}) };
}

/** A short, stable digest of what was found (rules and evidence), for "ask again when this changes". */
export function codeScanDigest(findings: readonly ICodeScanFinding[]): string {
	let hash = 0;
	for (const text of findings.map(finding => `${finding.rule}:${finding.evidence}`).sort()) {
		for (let i = 0; i < text.length; i++) {
			hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
		}
		hash = (Math.imul(hash, 31) + 10) | 0;
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

// --- reading an extension's folder -----------------------------------------------------------------

/** How the scan reads a folder: the window's file service, or Node's `fs` in tests and the server. */
export interface ICodeScanReader {
	/** Entries of a folder: names, and whether each is a folder. Symbolic links are left out. */
	list(path: string): Promise<readonly { readonly name: string; readonly directory: boolean; readonly size?: number }[]>;
	read(path: string): Promise<string>;
}

/** The scannable files under `root` (POSIX paths), within {@link CODE_SCAN_LIMITS}; the rest are counted. */
export async function readScanFiles(root: string, reader: ICodeScanReader): Promise<{ readonly files: ICodeScanFile[]; readonly skipped: number }> {
	const files: ICodeScanFile[] = [];
	let skipped = 0;
	let bytes = 0;
	const walk = async (relative: string, depth: number): Promise<void> => {
		if (depth > CODE_SCAN_LIMITS.depth) {
			skipped++;
			return;
		}
		const entries = await reader.list(relative ? `${root}/${relative}` : root).catch(() => []);
		for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.directory) {
				// Volt's own copy of the marketplace metadata and VCS folders hold no code.
				if (entry.name !== '.git' && entry.name !== '.vscode-test') {
					await walk(path, depth + 1);
				}
				continue;
			}
			if (!isScannableFile(entry.name)) {
				continue;
			}
			if (files.length >= CODE_SCAN_LIMITS.files || (entry.size ?? 0) > CODE_SCAN_LIMITS.fileBytes || bytes + (entry.size ?? 0) > CODE_SCAN_LIMITS.bytes) {
				skipped++;
				continue;
			}
			const text = await reader.read(`${root}/${path}`).catch(() => undefined);
			if (text === undefined) {
				skipped++;
				continue;
			}
			bytes += text.length;
			files.push({ path, text });
		}
	};
	await walk('', 0);
	return { files, skipped };
}
