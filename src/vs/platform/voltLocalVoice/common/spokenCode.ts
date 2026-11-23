/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * An agent's reply as a developer would say it out loud. A speech model reads `README.md`,
 * `src/vs/agentEditor.ts`, `v1.2.3` or `a && b` letter by letter or not at all; a person says
 * "readme dot M D", "agent editor dot T S", "version one point two point three", "a and b".
 * Numbers, dates and ranges are written out in words too: a speech model reading digits guesses,
 * and "17 Oct" or "147" came out as "octo de" and "144 in". Plain prose passes through unchanged.
 */

import { integerWords, ONES, ordinal } from './lexiconSpeech.js';

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

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MONTH_NAME = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

/** Shorthand developers write and say in full. */
const SHORTHAND: Record<string, string> = { e2e: 'end to end', a11y: 'accessibility', i18n: 'internationalization', l10n: 'localization', k8s: 'Kubernetes' };

function monthIndex(name: string): number {
	return MONTH_SHORT[name.slice(0, name.toLowerCase().startsWith('sept') ? 4 : 3).toLowerCase()];
}

/** "October seventeenth", and the year after it when there is one: "October seventeenth, twenty twenty six". */
function sayDate(month: number, day: string, year?: string): string {
	const said = `${MONTHS[month]} ${ordinal(integerWords(String(Number(day)), false)).join(' ')}`;
	return year ? `${said}, ${integerWords(year, true).join(' ')}` : said;
}

/** `2026-10-17` as a date, when its month and day are real ones. */
function isoDate(year: string, month: string, day: string): string | undefined {
	const m = Number(month);
	const d = Number(day);
	return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? sayDate(m - 1, day, year) : undefined;
}

/** A number in words: `147` "one hundred forty seven", `2026` "twenty twenty six", `3.5` "three point five". */
function sayNumber(written: string): string {
	const [whole, fraction] = written.split('.');
	const words = integerWords(whole, !fraction);
	if (fraction) {
		words.push('point', ...[...fraction].map(digit => ONES[Number(digit)]));
	}
	return words.join(' ');
}

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

/**
 * A file's base name: `09-GAP-STATUS-2026-10-17` as "gap status October seventeenth, twenty twenty
 * six". The sort number in front is not said; a name in capitals reads as words, not letters.
 */
function sayBaseName(name: string): string {
	let base = name.replace(/^\d{1,3}[-_](?=[A-Za-z])/, '');
	// `GAP-STATUS` or `MAX_RETRY` reads as words; a lone `API` stays initials. Numbers do not count.
	const named = base.split(/[-_]+/).filter(word => word && !/^\d+$/.test(word));
	const shouted = named.length > 1 && named.every(word => !/[a-z]/.test(word));
	base = base.replace(/(^|[-_])(\d{4})[-_](\d{2})[-_](\d{2})(?=$|[-_])/g, (match, lead: string, year: string, month: string, day: string) => {
		const date = isoDate(year, month, day);
		return date ? `${lead}${date.replace(/,/g, '')}` : match;
	});
	const words = base.split(/[-_]+/).filter(Boolean);
	return words.map(word => shouted && /^[A-Z]{2,}$/.test(word) ? word.toLowerCase() : splitName(word)).join(' ');
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
			said.push(sayBaseName(part));
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
	said = said.replace(/\b(e2e|a11y|i18n|l10n|k8s)\b/gi, word => SHORTHAND[word.toLowerCase()]);
	// Dates, before their digits and dashes are read as anything else.
	said = said.replace(/(?<![\w./-])(\d{4})-(\d{2})-(\d{2})(?![\w/-]|\.\w)/g, (match, year: string, month: string, day: string) => isoDate(year, month, day) ?? match);
	said = said.replace(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME}\\.?(?:\\s+(\\d{4}))?\\b`, 'g'), (_match, day: string, month: string, year: string | undefined) => sayDate(monthIndex(month), day, year));
	said = said.replace(new RegExp(`\\b${MONTH_NAME}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!:)(?:,?\\s+(\\d{4})\\b)?`, 'g'), (_match, month: string, day: string, year: string | undefined) => sayDate(monthIndex(month), day, year));
	// `DEC-006` as "DEC six" (the model reads capitals as initials itself); `006` en dash `008` as "six to eight".
	said = said.replace(/\b([A-Z]{2,4})-0*(\d+)\b/g, (_match, letters: string, digits: string) => `${letters} ${digits || '0'}`);
	said = said.replace(/(\d)\s?[\u2013\u2014]\s?0*(\d)/g, '$1 to $2');
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
	// Numbers in words, last: everything above may have left digits (`1 point 2`, `9 0 3 1`, `about 56`).
	// A number written with commas is a count, never a year: `1,200` "one thousand two hundred".
	said = said.replace(/(?<![$\d])\b\d{1,3}(?:,\d{3})+\b(?!\.\d)/g, number => integerWords(number.replace(/,/g, ''), false).join(' '));
	said = said.replace(/\$\d{1,3}(?:,\d{3})+/g, number => number.replace(/,/g, ''));
	// Money as it is said: `$3.50` "three dollars and fifty cents", `$5` "five dollars".
	said = said.replace(/\$(\d+)(?:\.(\d{1,2}))?(?![\d.]*\d)/g, (_match, whole: string, fraction: string | undefined) => {
		const cents = fraction ? Number(fraction.padEnd(2, '0')) : 0;
		const dollars = `${integerWords(whole, false).join(' ')} ${whole === '1' ? 'dollar' : 'dollars'}`;
		return cents ? `${dollars} and ${integerWords(String(cents), false).join(' ')} ${cents === 1 ? 'cent' : 'cents'}` : dollars;
	});
	said = said.replace(/(\d)\s?%/g, '$1 percent');
	said = said.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_match, digits: string) => ordinal(integerWords(digits, false)).join(' '));
	said = said.replace(/(?<![\w.])(\d+(?:\.\d+)?)(?![\w]|\.\d)/g, number => sayNumber(number));
	// What is left of markup and code punctuation.
	said = said.replace(/[*_|\\<>{}[\]^~]+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/,(?:\s*,)+/g, ',').replace(/,\s*([.;:!?])/g, '$1').replace(/([.!?]),/g, '$1').replace(/^[\s,]+/, '').replace(/[ \t]{2,}/g, ' ');
	return said.trim();
}
