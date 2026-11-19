/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * An agent's reply as a developer would say it out loud. A speech model reads `README.md`,
 * `src/vs/agentEditor.ts`, `v1.2.3` or `a && b` letter by letter or not at all; a person says
 * "readme dot M D", "agent editor dot T S", "version one point two point three", "a and b".
 * Plain prose passes through unchanged.
 */

/** How a file extension is said: letters for the ones nobody pronounces, the word for the rest. */
const EXTENSIONS: Record<string, string> = {
	md: 'M D', mdx: 'M D X', ts: 'T S', tsx: 'T S X', js: 'J S', jsx: 'J S X', mjs: 'M J S', cjs: 'C J S', mts: 'M T S', cts: 'C T S',
	json: 'JSON', jsonc: 'JSON C', yaml: 'yaml', yml: 'Y M L', toml: 'toml', xml: 'X M L', csv: 'C S V', ini: 'I N I', env: 'env', lock: 'lock',
	html: 'H T M L', htm: 'H T M', css: 'C S S', scss: 'S C S S', less: 'less', svg: 'S V G', vue: 'view', svelte: 'svelte',
	py: 'pie', rb: 'R B', rs: 'R S', go: 'go', java: 'java', kt: 'K T', swift: 'swift', c: 'C', h: 'H', cpp: 'C P P', hpp: 'H P P', cs: 'C S', php: 'P H P',
	sh: 'S H', bash: 'bash', zsh: 'Z S H', ps1: 'P S one', sql: 'S Q L', proto: 'proto', gradle: 'gradle', plist: 'P list',
	txt: 'T X T', log: 'log', pdf: 'P D F', png: 'P N G', jpg: 'J P G', jpeg: 'J peg', gif: 'gif', webp: 'web P', ico: 'I C O',
	mp3: 'M P three', mp4: 'M P four', wav: 'wave', zip: 'zip', tar: 'tar', gz: 'G Z', tgz: 'T G Z', dmg: 'D M G', exe: 'E X E', wasm: 'wasm', onnx: 'onyx', bin: 'bin',
	http: 'H T T P', diff: 'diff', patch: 'patch', map: 'map', d: 'D', test: 'test', spec: 'spec', config: 'config', min: 'min', module: 'module', contribution: 'contribution',
};

/** Names written in capitals that are words, not initials. */
const SHOUTED_WORDS: Record<string, string> = {
	README: 'readme', TODO: 'to do', FIXME: 'fix me', LICENSE: 'license', CHANGELOG: 'changelog', CONTRIBUTING: 'contributing', NOTE: 'note', MEMORY: 'memory', CLAUDE: 'Claude', AGENTS: 'agents', HEAD: 'head', WIP: 'work in progress',
};

const UNITS: Record<string, string> = {
	ms: 'milliseconds', s: 'seconds', KB: 'kilobytes', kB: 'kilobytes', MB: 'megabytes', GB: 'gigabytes', TB: 'terabytes', px: 'pixels', fps: 'frames per second', Hz: 'hertz', kHz: 'kilohertz', x: 'times',
};

const ABBREVIATIONS: readonly [RegExp, string][] = [
	[/\be\.g\.,?/gi, 'for example,'],
	[/\bi\.e\.,?/gi, 'that is,'],
	[/\bvs\.?(?=\s)/gi, 'versus'],
	[/\bw\/(?=\s?\w)/gi, 'with '],
	[/\betc\.(?=\s+[a-z])/g, 'etcetera,'],
];

/** `agentEditor` or `read_aloud_voice` as separate words; a name in capitals stays as it is. */
function splitName(name: string): string {
	const shouted = SHOUTED_WORDS[name];
	if (shouted) {
		return shouted;
	}
	let words = name.replace(/[_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').trim();
	// SCREAMING_SNAKE reads as words, not as letters.
	if (/_/.test(name) && name === name.toUpperCase()) {
		words = words.toLowerCase();
	}
	// `agentEditor` is "agent editor"; initials inside a name (`readURL`) keep their capitals.
	const split = words.includes(' ');
	return words.split(' ').map(word => SHOUTED_WORDS[word] ?? (split && /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word)).join(' ');
}

/** `agentEditor.test.ts` as "agent editor dot test dot T S"; `.gitignore` as "dot gitignore". */
function sayFile(name: string): string {
	const parts = name.split('.');
	const said: string[] = [];
	for (const [index, part] of parts.entries()) {
		if (!part) {
			continue;
		}
		if (index === 0) {
			said.push(splitName(part.replace(/-/g, ' ')));
		} else {
			said.push(`dot ${EXTENSIONS[part.toLowerCase()] ?? splitName(part.replace(/-/g, ' '))}`);
		}
	}
	return said.join(' ');
}

function isFileName(token: string): boolean {
	const dot = token.lastIndexOf('.');
	if (dot < 0) {
		return false;
	}
	if (dot === 0) {
		// A dotfile: `.env`, `.gitignore`.
		return /^\.[a-z][\w-]+$/i.test(token);
	}
	return /^[\w-]+(\.[\w-]+)*$/.test(token) && /[A-Za-z_]/.test(token.slice(0, dot)) && Object.prototype.hasOwnProperty.call(EXTENSIONS, token.slice(dot + 1).toLowerCase());
}

/** A path as a person points at it: the file, and the folder it is in when the path is short. */
function sayPath(path: string): string {
	const home = path.startsWith('~');
	const segments = path.replace(/^~/, '').split('/').filter(segment => segment && segment !== '.');
	if (!segments.length) {
		return home ? 'the home folder' : 'slash';
	}
	const say = (segment: string) => segment === '..' ? 'dot dot' : isFileName(segment) ? sayFile(segment) : splitName(segment.replace(/[-.]/g, ' '));
	const last = say(segments[segments.length - 1]);
	if (segments.length === 1) {
		return last;
	}
	if (segments.length === 2) {
		return `${say(segments[0])} slash ${last}`;
	}
	// A long path is noise out loud: the file, and where it lives.
	return `${last} in ${say(segments[segments.length - 2])}`;
}

function sayNumberParts(written: string): string {
	return written.split('.').join(' point ');
}

export function spokenCode(text: string): string {
	let said = text;
	// Marks that are drawn, not said.
	said = said.replace(/[\u2713\u2714\u2705\u2717\u2718\u274c\u2022\u25cf\u25cb\u2192\u2190\u21d2]|[\u{1f300}-\u{1faff}]|\ufe0f/gu, match => match === '\u2192' || match === '\u21d2' ? ' to ' : ' ');
	for (const [pattern, words] of ABBREVIATIONS) {
		said = said.replace(pattern, words);
	}
	// Operators, before the names around them are touched.
	said = said
		.replace(/\s(?:=>|->)\s/g, ' to ')
		.replace(/\s&&\s/g, ' and ')
		.replace(/\s\|\|\s/g, ' or ')
		.replace(/\s!==?\s/g, ' is not ')
		.replace(/\s===?\s/g, ' equals ')
		.replace(/\s>=\s/g, ' is at least ')
		.replace(/\s<=\s/g, ' is at most ')
		.replace(/\s&\s/g, ' and ')
		.replace(/(^|\s)#(\d+)\b/g, '$1number $2')
		.replace(/(^|\s)~(?=\d)/g, '$1about ')
		.replace(/(^|\s)--([a-z][\w-]*)/gi, (_match, lead: string, flag: string) => `${lead}dash dash ${flag.replace(/-/g, ' ')}`)
		.replace(/(^|[\s(])@([A-Za-z][\w-]*)/g, '$1at $2');
	// A call's empty brackets say nothing.
	said = said.replace(/\b([A-Za-z_][\w.]*)\(\)/g, '$1');
	// An aside in brackets is an aside between commas.
	said = said.replace(/\s*\(([^()]{1,200})\)/g, (_match, inner: string) => `, ${inner.trim()},`);
	// Commit hashes: the first four characters, one at a time.
	said = said.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, hash => [...hash.slice(0, 4)].join(' '));
	// Numbers with a unit, versions and decimals.
	said = said.replace(/(\d)\s?(ms|KB|kB|MB|GB|TB|px|fps|kHz|Hz)\b/g, (_match, digit: string, unit: string) => `${digit} ${UNITS[unit]}`);
	said = said.replace(/(\d)(x|\u00d7)(?=[\s.,;:!?)]|$)/g, '$1 times');
	said = said.replace(/(\bversion)?(^|[\s(])v(\d+(?:\.\d+)+)\b/gi, (_match, named: string | undefined, lead: string, version: string) => `${named ?? ''}${lead}${named ? '' : 'version '}${sayNumberParts(version)}`);
	said = said.replace(/(^|[^\w$.])(\d+(?:\.\d+){2,})\b/g, (_match, lead: string, version: string) => `${lead}${sayNumberParts(version)}`);
	said = said.replace(/(^|[^\w$.])(\d+\.0\d+)\b/g, (_match, lead: string, version: string) => `${lead}${sayNumberParts(version)}`);
	// Paths, file names and code names, a token at a time.
	said = said.replace(/[^\s,;:!?()"'`]+/g, token => {
		const end = /[.]+$/.exec(token)?.[0] ?? '';
		const core = end ? token.slice(0, -end.length) : token;
		if (!core) {
			return token;
		}
		if (/^(?:~|\.{1,2})?(?:\/[\w.@+-]+)+\/?$/.test(core) || /^[\w.@+-]+(?:\/[\w.@+-]+)+\/?$/.test(core) && /[A-Za-z]/.test(core)) {
			// `and/or`, `yes/no`: two plain words are a choice, not a path.
			if (/^[a-z]+\/[a-z]+$/.test(core)) {
				return `${core === 'and/or' ? 'and or' : core.replace('/', ' or ')}${end}`;
			}
			return `${sayPath(core)}${end}`;
		}
		if (isFileName(core)) {
			return `${sayFile(core)}${end}`;
		}
		if (/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(core) && /[a-z][A-Z]|_/.test(core)) {
			// `service.getStates`: a member of something.
			return `${core.split('.').map(splitName).join(' dot ')}${end}`;
		}
		if (/^[A-Za-z_][\w]*$/.test(core) && (/[a-z][A-Z]|[A-Za-z]_[A-Za-z]/.test(core) || SHOUTED_WORDS[core])) {
			return `${splitName(core)}${end}`;
		}
		return token;
	});
	// What is left of markup and code punctuation.
	said = said.replace(/[*_|\\<>{}[\]^~]+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/,(?:\s*,)+/g, ',').replace(/,\s*([.;:!?])/g, '$1').replace(/([.!?]),/g, '$1').replace(/^[\s,]+/, '').replace(/[ \t]{2,}/g, ' ');
	return said.trim();
}
