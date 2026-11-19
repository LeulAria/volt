/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The speech engine pronounces only the words in its dictionary (about 178,000 English words) and
 * drops every other token without a sound: numbers, `user's`, `(API)`, `worktree`, `agentEditor`.
 * This turns text into dictionary words and sentence punctuation only, so nothing goes missing:
 * numbers and units are spelled out, identifiers are split into their words, compounds are cut
 * into known words, and what is left is read letter by letter.
 */

export const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];
const ORDINALS: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

/** Units written against a number (`10ms`, `2x`). Those with a plural take an `s` past one. */
const UNITS: Record<string, { readonly words: string; readonly plural?: boolean }> = {
	ms: { words: 'millisecond', plural: true },
	s: { words: 'second', plural: true },
	sec: { words: 'second', plural: true },
	min: { words: 'minute', plural: true },
	h: { words: 'hour', plural: true },
	hr: { words: 'hour', plural: true },
	KB: { words: 'kilobyte', plural: true },
	kB: { words: 'kilobyte', plural: true },
	MB: { words: 'megabyte', plural: true },
	GB: { words: 'gigabyte', plural: true },
	TB: { words: 'terabyte', plural: true },
	px: { words: 'pixel', plural: true },
	fps: { words: 'frames per second' },
	x: { words: 'times' },
	k: { words: 'thousand' },
	K: { words: 'thousand' },
	M: { words: 'million' },
};

/** Units that are still units after a space (`42 ms`); the one-letter ones would be words there. */
const SPACED_UNITS = new Set(['ms', 'KB', 'kB', 'MB', 'GB', 'TB', 'px', 'fps']);

/** Two capitals that are a word shouted, not initials. */
const SHOUTED = new Set(['am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'me', 'my', 'no', 'of', 'ok', 'on', 'or', 'so', 'to', 'up', 'we']);

/** How developers say what the dictionary lacks, in words it has. */
const RESPELLED: Record<string, string> = {
	json: 'jason',
	github: 'git hub',
	gitlab: 'git lab',
	sql: 'sequel',
	gui: 'gooey',
	api: 'a p i',
	apis: 'a p i \'s',
	cli: 'c l i',
	ui: 'u i',
	url: 'u r l',
	urls: 'u r l \'s',
	http: 'h t t p',
	https: 'h t t p s',
	stdin: 'standard in',
	stdout: 'standard out',
	stderr: 'standard error',
	config: 'con fig',
	configs: 'con figs',
	changelog: 'change log',
	readme: 'read me',
	todo: 'to do',
	kubectl: 'cube control',
	nginx: 'engine x',
	wasm: 'web assembly',
	macos: 'mac o s',
	eslint: 'e s lint',
	golang: 'go lang',
	oauth: 'o auth',
	param: 'parameter',
	params: 'parameter \'s',
	args: 'argument \'s',
	enum: 'enumeration',
	struct: 'structure',
	tuple: 'too pull',
};

const SYMBOLS: Record<string, string> = { '&': 'and', '+': 'plus', '=': 'equals', '@': 'at', '%': 'percent' };

/** The dictionary's own entry for a trailing s sound. */
const PLURAL = '\'s';
/** And for a trailing d sound. */
const PAST = '\'d';

type Has = (word: string) => boolean;

function below1000(n: number): string[] {
	const words: string[] = [];
	if (n >= 100) {
		words.push(ONES[Math.floor(n / 100)], 'hundred');
		n %= 100;
	}
	if (n >= 20) {
		words.push(TENS[Math.floor(n / 10)]);
		n %= 10;
		if (n) {
			words.push(ONES[n]);
		}
	} else if (n || !words.length) {
		words.push(ONES[n]);
	}
	return words;
}

function cardinal(n: number): string[] {
	if (n < 1000) {
		return below1000(n);
	}
	const words: string[] = [];
	const groups: number[] = [];
	for (; n > 0; n = Math.floor(n / 1000)) {
		groups.push(n % 1000);
	}
	for (let i = groups.length - 1; i >= 0; i--) {
		if (groups[i]) {
			words.push(...below1000(groups[i]), ...(SCALES[i] ? [SCALES[i]] : []));
		}
	}
	return words;
}

/** `1984` as "nineteen eighty four", `2026` as "twenty twenty six". */
function yearWords(n: number): string[] {
	const high = below1000(Math.floor(n / 100));
	const low = n % 100;
	return low === 0 ? [...high, 'hundred'] : low < 10 ? [...high, 'oh', ONES[low]] : [...high, ...below1000(low)];
}

export function integerWords(digits: string, yearStyle: boolean): string[] {
	// Past what a double counts exactly, and for codes with a leading zero: digit by digit.
	if (digits.length > 15 || (digits.length > 1 && digits[0] === '0')) {
		return [...digits].map(digit => ONES[Number(digit)]);
	}
	const n = Number(digits);
	if (yearStyle && digits.length === 4 && ((n >= 1100 && n <= 1999) || (n >= 2010 && n <= 2099))) {
		return yearWords(n);
	}
	return cardinal(n);
}

export function ordinal(words: string[]): string[] {
	const last = words[words.length - 1];
	const said = ORDINALS[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
	return [...words.slice(0, -1), said];
}

/** A word cut into dictionary words, as few and as long as possible; letters where nothing fits. */
function segment(word: string, has: Has): string[] {
	const length = word.length;
	const cost: number[] = [0];
	const from: number[] = [0];
	for (let end = 1; end <= length; end++) {
		cost[end] = Infinity;
		for (let start = Math.max(0, end - 24); start < end; start++) {
			const size = end - start;
			let price: number;
			if (size === 1) {
				price = 6;
			} else if (has(word.slice(start, end))) {
				price = size === 2 ? 4 : size === 3 ? 1.6 : 1;
			} else {
				continue;
			}
			if (cost[start] + price < cost[end]) {
				cost[end] = cost[start] + price;
				from[end] = start;
			}
		}
	}
	const pieces: string[] = [];
	for (let end = length; end > 0; end = from[end]) {
		pieces.unshift(word.slice(from[end], end));
	}
	return pieces.filter(has);
}

function spell(word: string, has: Has): string[] {
	return [...word].filter(has);
}

/** Fixed words (number names, units) checked against the dictionary like everything else. */
function known(words: string[], has: Has): string[] {
	return words.flatMap(word => has(word) ? [word] : sayWord(word, has));
}

function sayWord(raw: string, has: Has): string[] {
	const word = raw.replace(/^'+|'+$/g, '');
	if (!word) {
		return [];
	}
	const lower = word.toLowerCase();
	const capitals = word.length > 1 && word === word.toUpperCase();
	if (capitals && word.length === 2 && !SHOUTED.has(lower)) {
		return spell(lower, has);
	}
	const respelled = RESPELLED[lower]?.split(' ');
	if (respelled?.every(has)) {
		return respelled;
	}
	if (has(lower)) {
		return [lower];
	}
	const apostrophe = lower.indexOf('\'');
	if (apostrophe > 0) {
		// "Volt's" sounds like "volts"; any other unknown contraction keeps its first part.
		const base = lower.slice(0, apostrophe);
		if (lower.endsWith('\'s')) {
			return has(`${base}s`) ? [`${base}s`] : [...sayWord(word.slice(0, apostrophe), has), ...(has(PLURAL) ? [PLURAL] : [])];
		}
		return sayWord(word.slice(0, apostrophe), has);
	}
	// The dictionary lacks many plurals (it has "millisecond", not "milliseconds").
	if (lower.length > 3 && lower.endsWith('s') && has(lower.slice(0, -1)) && has(PLURAL)) {
		return [lower.slice(0, -1), PLURAL];
	}
	// And some past tenses (the British one has "pass", not "passed").
	if (lower.length > 4 && lower.endsWith('ed') && has(PAST)) {
		const stem = [lower.slice(0, -2), lower.slice(0, -1)].find(has);
		if (stem) {
			return [stem, PAST];
		}
	}
	const parts = word.split(/_+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean);
	if (parts.length > 1) {
		return parts.flatMap(part => sayWord(part, has));
	}
	if ((capitals && lower.length <= 5) || !/[aeiouy]/.test(lower)) {
		return spell(lower, has);
	}
	return segment(lower, has);
}

function sayNumber(dollar: boolean, written: string, suffix: string | undefined, has: Has): string[] {
	const groups = written.replace(/,/g, '').split('.');
	let words: string[];
	if (groups.length > 2) {
		// A version: 1.2.3.
		words = groups.flatMap((group, index) => [...(index ? ['point'] : []), ...integerWords(group, false)]);
	} else {
		words = integerWords(groups[0], !suffix && !dollar && groups.length === 1 && !written.includes(','));
		if (groups[1]) {
			words.push('point', ...[...groups[1]].map(digit => ONES[Number(digit)]));
		}
	}
	const one = written === '1';
	let rest: string[] = [];
	if (suffix === '%') {
		words.push('percent');
	} else if (suffix && /^(st|nd|rd|th)$/.test(suffix) && groups.length === 1) {
		words = ordinal(words);
	} else if (suffix && UNITS[suffix]) {
		words.push(...unitWords(suffix, one));
	} else if (suffix) {
		rest = sayWord(suffix, has);
	}
	if (dollar) {
		words.push(one ? 'dollar' : 'dollars');
	}
	return [...known(words, has), ...rest];
}

function unitWords(unit: string, one: boolean): string[] {
	const { words, plural } = UNITS[unit];
	return (plural && !one ? `${words}s` : words).split(' ');
}

// A number with what is written against it | a word | sentence punctuation | a pause | any other sign.
const TOKEN = /(\$)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)*)(%|[A-Za-z]+)?|([A-Za-z][A-Za-z_']*)|([.!?]+)|([,;:]+)|(\S)/g;

/**
 * `text` as lowercase dictionary words with `. ! ? , ; :` between them. `has` says whether the
 * dictionary knows a lowercase word.
 */
export function lexiconSpeech(text: string, has: Has): string {
	const source = text.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '')
		.replace(/[\u2018\u2019\u02bc`]/g, '\'')
		.replace(/\be\.g\.?(?=[\s,]|$)/gi, 'for example')
		.replace(/\bi\.e\.?(?=[\s,]|$)/gi, 'that is')
		.replace(/\betc\./gi, 'and so on.')
		.replace(/\bvs\.?(?=\s)/gi, 'versus')
		.replace(/->|=>|[\u2190-\u21ff]/g, ', ')
		.replace(/[()[\]{}\u2013\u2014]|\s-+\s/g, ', ')
		.replace(/(?<=[A-Za-z_])(?=\d)/g, ' ');

	const out: string[] = [];
	const mark = (sign: string) => {
		const last = out[out.length - 1];
		if (last === undefined) {
			return;
		}
		const ended = /[.!?,;:]$/.exec(last);
		if (!ended) {
			out[out.length - 1] = last + sign;
		} else if (/[,;:]/.test(ended[0]) && /[.!?]/.test(sign)) {
			out[out.length - 1] = last.slice(0, -1) + sign;
		}
	};
	/** Set after a bare number, for a unit that follows a space: whether the number was one. */
	let afterNumber: { readonly one: boolean } | undefined;
	for (const match of source.matchAll(TOKEN)) {
		const [whole, dollar, number, suffix, word, stop, pause, sign] = match;
		const numbered = afterNumber;
		afterNumber = undefined;
		if (number !== undefined) {
			out.push(...sayNumber(!!dollar, number, suffix, has));
			afterNumber = suffix || dollar ? undefined : { one: number === '1' };
		} else if (word !== undefined) {
			out.push(...(numbered && SPACED_UNITS.has(word) ? known(unitWords(word, numbered.one), has) : sayWord(word, has)));
		} else if (stop !== undefined) {
			const before = source[match.index - 1];
			const after = source[match.index + whole.length];
			if (stop === '.' && before && after && /\w/.test(before) && /\w/.test(after)) {
				// A dot inside a name: agentEditor.ts.
				out.push(...known(['dot'], has));
			} else {
				mark(stop[0]);
			}
		} else if (pause !== undefined) {
			mark(pause[0]);
		} else if (sign !== undefined && SYMBOLS[sign]) {
			out.push(...known([SYMBOLS[sign]], has));
		}
	}
	if (!out.length) {
		return '';
	}
	const last = out[out.length - 1];
	if (/[,;:]$/.test(last)) {
		out[out.length - 1] = `${last.slice(0, -1)}.`;
	} else if (!/[.!?]$/.test(last)) {
		out[out.length - 1] = `${last}.`;
	}
	return out.join(' ');
}

/** The dictionary's words: the first column of each line of a lexicon file. */
export function lexiconWords(lexicon: string): Set<string> {
	const words = new Set<string>();
	for (let start = 0; start < lexicon.length;) {
		let end = lexicon.indexOf('\n', start);
		if (end < 0) {
			end = lexicon.length;
		}
		const space = lexicon.indexOf(' ', start);
		if (space > start && space < end) {
			words.add(lexicon.slice(start, space));
		}
		start = end + 1;
	}
	return words;
}
