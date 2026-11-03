/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Shell commands as the desktop titles and colours them (agentBlocks.ts, agentBlockRenderers.ts):
// "Ran Run tests npm", and `$ npm test` with the program, flags, strings and variables tinted.

const GENERIC_SHELL_TITLE_RE = /^(bash|sh|zsh|fish|shell|terminal|cmd|command|exec|execute|run|process|stdout|run_terminal_cmd|run_command|shell_command)$/i;
const SHELL_START_RE = /^(sudo\s+)?(ls|cd|pwd|find|grep|rg|cat|head|tail|git|npm|npx|pnpm|yarn|bun|make|echo|curl|wget|python3?|node|cargo|go|docker|kubectl|chmod|chown|rm|mv|cp|mkdir|touch|which|export|source|bash|zsh|sh|for|if)\b/;
const LABEL_KEYWORDS = new Set(['for', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'case', 'esac', 'in', 'select', 'function', '{', '}', '!']);
const SHELL_KEYWORD_PREFIX_RE = /^(?:(?:do|then|else|elif|!)\s+)+/;
const NOISE_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':', 'tee', 'xargs', 'awk', 'sed', 'tr', 'cut', 'uniq', 'wc']);

export function stripPrompt(command: string): string {
	return command.replace(/^[$%>#]+_?\s*/, '').trim();
}

/** The program a command runs: quoted paths stay whole, an absolute path shows its file name, an app binary its app. */
export function firstCommandName(command: string): string {
	const tokens = stripPrompt(command).match(/"[^"]*"|'[^']*'|[^\s;|&]+/g) ?? [];
	const word = tokens.find(part => part && !part.startsWith('-') && (/^["']/.test(part) || !part.includes('='))) ?? '';
	const program = word.replace(/^(["'])([\s\S]*)\1$/, '$2');
	const app = /\/([^/]+)\.app\/Contents\/MacOS\//.exec(program);
	if (app) {
		return app[1];
	}
	if (program.startsWith('/') || program.startsWith('~/')) {
		return program.slice(program.lastIndexOf('/') + 1);
	}
	return program.replace(/^\.\//, '');
}

/** The programs a command line runs, for the quiet tail of "Ran Run tests npm, jest". */
export function terminalCommandLabels(command: string): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const part of stripPrompt(command).split(/\s*(?:&&|\|\||[;|])\s*/)) {
		const name = firstCommandName(part.replace(SHELL_KEYWORD_PREFIX_RE, ''));
		if (!name || NOISE_COMMANDS.has(name) || LABEL_KEYWORDS.has(name) || seen.has(name)) {
			continue;
		}
		seen.add(name);
		names.push(name);
	}
	return names.length <= 2 ? names : [names[0], names[names.length - 1]];
}

/** A command's title: the agent's own description when it says something, else what the command does. */
export function humanTerminalTitle(title: string | undefined, command: string): string {
	const t = stripTrailingCommandList(stripPrompt(title?.trim() ?? ''));
	if (isDescriptiveTitle(t) && t.toLowerCase() !== stripPrompt(command).toLowerCase()) {
		return t;
	}
	return describeShellCommand(command) || firstCommandName(command) || 'Command';
}

function isDescriptiveTitle(text: string): boolean {
	if (!text || GENERIC_SHELL_TITLE_RE.test(text) || looksLikeCommandLine(text)) {
		return false;
	}
	return text.split(/\s+/).filter(Boolean).length >= 2 && text.length >= 8;
}

function stripTrailingCommandList(title: string): string {
	return title.replace(/\s*`[^`]+`\s*$/, '').replace(/\s+[a-z][\w.-]*(?:\s*,\s*[a-z][\w.-]*)+$/i, '').trim();
}

function looksLikeCommandLine(text: string): boolean {
	const trimmed = stripPrompt(text);
	if (/[|&;]/.test(trimmed) || /\s-\w/.test(trimmed)) {
		return true;
	}
	return !/\s/.test(trimmed) && !!firstCommandName(trimmed) && (SHELL_START_RE.test(trimmed) || GENERIC_SHELL_TITLE_RE.test(trimmed));
}

const SIMPLE_TITLES: Readonly<Record<string, string>> = {
	grep: 'Search files', rg: 'Search files', cat: 'Read file', bat: 'Read file', head: 'Show first lines', tail: 'Show last lines',
	pwd: 'Print working directory', cd: 'Change directory', du: 'Show disk usage', ps: 'List processes', kill: 'Stop process',
	pkill: 'Stop process', killall: 'Stop process', which: 'Find program', command: 'Find program', type: 'Find program',
	mkdir: 'Create folder', rm: 'Delete files', cp: 'Copy files', mv: 'Move files', test: 'Check files', '[': 'Check files',
	curl: 'Fetch URL', wget: 'Fetch URL', make: 'Run make', docker: 'Run docker', kubectl: 'Run kubectl',
};

function describeShellCommand(command: string): string {
	const raw = stripPrompt(command);
	const whole = raw.toLowerCase();
	const first = firstCommandName(raw).toLowerCase();
	if (!first) {
		return '';
	}
	if (first === 'ls' || (/\bls\b/.test(whole) && first === 'find')) {
		const human = hasFlag(whole, 'h') || whole.includes('--human-readable');
		const bySize = hasFlag(whole, 'S') || /--sort=size|\bsort\b/.test(whole);
		const byTime = !bySize && (hasFlag(whole, 't') || /--sort=time/.test(whole));
		return `List files${bySize ? ' sorted by size' : byTime ? ' sorted by modification time' : ''}${human ? ' with human-readable sizes' : ''}`;
	}
	if (first === 'find') {
		return whole.includes('-name') || whole.includes('-iname') ? 'Find files by name' : whole.includes('-type d') ? 'Find directories' : 'Find files';
	}
	if (first === 'git') {
		const sub = raw.split(/\s+/)[1]?.toLowerCase() ?? '';
		const git: Record<string, string> = { status: 'Show git status', log: 'Show git history', diff: 'Show git diff', add: 'Stage files', commit: 'Create git commit', push: 'Push to remote', pull: 'Pull from remote', checkout: 'Switch git branch', switch: 'Switch git branch', branch: 'List git branches', clone: 'Clone repository' };
		return git[sub] ?? (sub ? `Run git ${sub}` : 'Run git');
	}
	if (first === 'lsof') {
		return /-i\s*tcp|-i\s*:|-itcp|-i:|listen/.test(whole) ? 'Check listening ports' : 'List open files';
	}
	if (first === 'npm' || first === 'pnpm' || first === 'yarn' || first === 'bun') {
		const parts = raw.split(/\s+/);
		const sub = parts[1]?.toLowerCase() ?? '';
		if (sub === 'i' || sub === 'install' || sub === 'add') {
			return 'Install packages';
		}
		if (sub === 'test') {
			return 'Run tests';
		}
		if (sub === 'run' || sub === 'start' || sub === 'dev' || sub === 'build') {
			return `Run ${first} ${sub === 'run' ? (parts[2] ?? 'script') : sub}`;
		}
		return `Run ${first}`;
	}
	if (first === 'python' || first === 'python3' || first === 'node') {
		if (/http\.server/.test(whole)) {
			const port = /http\.server\s+(\d{2,5})/.exec(whole);
			return port ? `Start HTTP server on ${port[1]}` : 'Start HTTP server';
		}
		return `Run ${first}`;
	}
	return SIMPLE_TITLES[first] ?? `Run ${first}`;
}

function hasFlag(command: string, flag: string): boolean {
	const long = new Set(['type', 'name', 'iname', 'path', 'print', 'exec', 'size', 'maxdepth', 'mindepth']);
	return command.split(/\s+/).some(token => /^-[a-zA-Z]{1,5}$/.test(token) && !long.has(token.slice(1)) && token.includes(flag));
}

//#region Highlighting

const SHELL_BUILTINS = new Set([
	'.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete', 'continue', 'declare',
	'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history',
	'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return',
	'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
]);
const SHELL_KEYWORDS = new Set(['case', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'select', 'then', 'time', 'until', 'while']);

/** `cmd`, `builtin` and `kw` share a colour, as do `flag` and `num` (agentTranscript.css `.volt-tr-terminal-command`). */
export type ShellTokenKind = 'cmd' | 'builtin' | 'kw' | 'flag' | 'str' | 'var' | 'op' | 'num' | 'text';

export interface IShellToken {
	readonly kind: ShellTokenKind;
	readonly value: string;
}

/** The desktop's command card colours, by token: dark, then light. */
export function shellTokenColor(kind: ShellTokenKind, scheme: 'dark' | 'light'): string | undefined {
	switch (kind) {
		case 'cmd':
		case 'builtin':
		case 'kw':
			return scheme === 'dark' ? '#EFB080' : '#A0522D';
		case 'flag':
		case 'num':
			return scheme === 'dark' ? '#D6D6DD' : undefined;
		case 'str':
			return scheme === 'dark' ? '#E394DC' : '#7565CC';
		case 'var':
			return scheme === 'dark' ? '#87C3FF' : '#005293';
		default:
			return undefined;
	}
}

const shellCache = new Map<string, readonly IShellToken[]>();

export function tokenizeShell(command: string): readonly IShellToken[] {
	const hit = shellCache.get(command);
	if (hit) {
		return hit;
	}
	const tokens: IShellToken[] = [];
	let i = 0;
	let expectCommand = true;
	const push = (kind: ShellTokenKind, value: string) => {
		if (value) {
			tokens.push({ kind, value });
		}
	};
	while (i < command.length) {
		const ch = command[i];
		if (/\s/.test(ch)) {
			let end = i + 1;
			while (end < command.length && /\s/.test(command[end])) {
				end++;
			}
			if (/\n/.test(command.slice(i, end))) {
				expectCommand = true;
			}
			push('text', command.slice(i, end));
			i = end;
			continue;
		}
		if (ch === '\'' || ch === '"') {
			let end = i + 1;
			while (end < command.length) {
				if (command[end] === '\\' && end + 1 < command.length) {
					end += 2;
					continue;
				}
				if (command[end++] === ch) {
					break;
				}
			}
			push('str', command.slice(i, end));
			i = end;
			expectCommand = false;
			continue;
		}
		if (ch === '$' && command[i + 1] === '(') {
			push('op', '$(');
			i += 2;
			expectCommand = true;
			continue;
		}
		if (ch === '$') {
			let end = i + 1;
			if (command[end] === '{') {
				while (end < command.length && command[end] !== '}') {
					end++;
				}
				if (command[end] === '}') {
					end++;
				}
			} else {
				while (end < command.length && /[\w?#!@*-]/.test(command[end])) {
					end++;
				}
			}
			push(end > i + 1 ? 'var' : 'text', command.slice(i, Math.max(end, i + 1)));
			i = Math.max(end, i + 1);
			expectCommand = false;
			continue;
		}
		const redir = /^\d*>{1,2}&?(?:\d+|-)?|^\d*</.exec(command.slice(i, i + 8));
		if (redir) {
			push('op', redir[0]);
			i += redir[0].length;
			expectCommand = false;
			continue;
		}
		if (command.startsWith('&&', i) || command.startsWith('||', i) || command.startsWith(';;', i)) {
			push('op', command.slice(i, i + 2));
			i += 2;
			expectCommand = true;
			continue;
		}
		if (ch === '|' || ch === ';' || ch === '&' || ch === '`' || ch === '(') {
			push('op', ch);
			i++;
			expectCommand = ch !== '&';
			continue;
		}
		if (ch === ')' || ch === '}' || ch === ']') {
			push('op', ch);
			i++;
			expectCommand = false;
			continue;
		}
		if (ch === '\\') {
			push('op', command.slice(i, Math.min(i + 2, command.length)));
			i = Math.min(i + 2, command.length);
			continue;
		}
		if (ch === '-' && i + 1 < command.length && /[\w-]/.test(command[i + 1])) {
			let end = i + 1;
			while (end < command.length && /[\w-]/.test(command[end])) {
				end++;
			}
			const flag = command.slice(i, end);
			push('flag', flag);
			i = end;
			expectCommand = flag === '-exec' || flag === '-execdir';
			continue;
		}
		if (/\d/.test(ch)) {
			let end = i + 1;
			while (end < command.length && /[\d.]/.test(command[end])) {
				end++;
			}
			push('num', command.slice(i, end));
			i = end;
			expectCommand = false;
			continue;
		}
		let end = i + 1;
		while (end < command.length && !/[\s|"'`;&(){}<>]/.test(command[end]) && command[end] !== '\\') {
			end++;
		}
		const word = command.slice(i, end);
		if (expectCommand && /^[A-Za-z_]\w*=/.test(word)) {
			// `FOO=1 cmd`: an assignment before the program; the program still comes next.
			push('var', word);
			i = end;
			continue;
		}
		if (expectCommand) {
			push(SHELL_KEYWORDS.has(word) ? 'kw' : SHELL_BUILTINS.has(word) ? 'builtin' : 'cmd', word);
			expectCommand = word === 'sudo' || word === 'xargs' || word === 'nice' || word === 'nohup' || word === 'time' || word === 'env' || word === 'command';
		} else {
			push('text', word);
			expectCommand = word === 'xargs';
		}
		i = end;
	}
	if (shellCache.size > 400) {
		shellCache.clear();
	}
	shellCache.set(command, tokens);
	return tokens;
}

//#endregion
