/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a large paste most likely is. The folded paste is saved under the matching extension, so
 * its chip shows the right icon, the preview is highlighted, and the agent's tools see `.json`,
 * `.log` or `.ts` instead of an anonymous text file.
 */
export interface IPastedLanguage {
	/** Monaco language id (`json`, `typescript`, `plaintext`). */
	readonly id: string;
	/** Extension of the saved copy, without the dot. */
	readonly ext: string;
	/** What the chip's hover and the preview call it. */
	readonly label: string;
}

const PLAIN: IPastedLanguage = { id: 'plaintext', ext: 'txt', label: 'Text' };

const LANGUAGES = {
	json: { id: 'json', ext: 'json', label: 'JSON' },
	jsonl: { id: 'json', ext: 'jsonl', label: 'JSON Lines' },
	xml: { id: 'xml', ext: 'xml', label: 'XML' },
	html: { id: 'html', ext: 'html', label: 'HTML' },
	diff: { id: 'diff', ext: 'diff', label: 'Diff' },
	log: { id: 'log', ext: 'log', label: 'Log' },
	csv: { id: 'csv', ext: 'csv', label: 'CSV' },
	tsv: { id: 'tsv', ext: 'tsv', label: 'TSV' },
	yaml: { id: 'yaml', ext: 'yaml', label: 'YAML' },
	markdown: { id: 'markdown', ext: 'md', label: 'Markdown' },
	python: { id: 'python', ext: 'py', label: 'Python' },
	typescript: { id: 'typescript', ext: 'ts', label: 'TypeScript' },
	javascript: { id: 'javascript', ext: 'js', label: 'JavaScript' },
	go: { id: 'go', ext: 'go', label: 'Go' },
	rust: { id: 'rust', ext: 'rs', label: 'Rust' },
	java: { id: 'java', ext: 'java', label: 'Java' },
	csharp: { id: 'csharp', ext: 'cs', label: 'C#' },
	cpp: { id: 'cpp', ext: 'cpp', label: 'C++' },
	sql: { id: 'sql', ext: 'sql', label: 'SQL' },
	shell: { id: 'shellscript', ext: 'sh', label: 'Shell' },
	css: { id: 'css', ext: 'css', label: 'CSS' },
} satisfies Record<string, IPastedLanguage>;

type LanguageKey = keyof typeof LANGUAGES;

/** Enough of the paste to tell; a 5 MB log reads the same in its first 400 lines. */
const SAMPLE_CHARS = 24_000;
const SAMPLE_LINES = 400;

/** Every guess the folded paste can get, for tests and the language list in the preview. */
export const PASTED_LANGUAGES: readonly IPastedLanguage[] = [PLAIN, ...Object.values(LANGUAGES)];

/** `1,203 lines`. */
export function formatLineCount(lines: number): string {
	return `${lines.toLocaleString('en-US')} ${lines === 1 ? 'line' : 'lines'}`;
}

function share(lines: readonly string[], test: (line: string) => boolean): number {
	if (!lines.length) {
		return 0;
	}
	let hits = 0;
	for (const line of lines) {
		if (test(line)) {
			hits++;
		}
	}
	return hits / lines.length;
}

function looksLikeJson(text: string, trimmed: string): 'parsed' | 'shape' | undefined {
	const first = trimmed[0];
	if (first !== '{' && first !== '[') {
		return undefined;
	}
	const last = trimmed[trimmed.length - 1];
	if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
		if (text.length <= 2_000_000) {
			try {
				JSON.parse(trimmed);
				return 'parsed';
			} catch {
				// Cut off or not JSON: the shape below decides.
			}
		}
	}
	// `{ "key": …` or `[{"a"…`, even when the paste is cut off.
	return /^[[{]\s*(?:"[^"\n]*"\s*:|\{\s*"|\[|"|-?\d|true|false|null|\]|\})/.test(trimmed) ? 'shape' : undefined;
}

/** Same count of `delimiter` on most lines, at least one per line. */
function delimited(lines: readonly string[], delimiter: string): boolean {
	const rows = lines.filter(line => line.trim()).slice(0, 60);
	if (rows.length < 3) {
		return false;
	}
	const counts = rows.map(row => row.split(delimiter).length - 1);
	const first = counts[0];
	if (first < 1) {
		return false;
	}
	return counts.filter(count => count === first).length / counts.length >= 0.8;
}

/**
 * A best guess from the paste's opening: structured formats first (JSON, XML, diffs, logs,
 * tables), then code by its tell-tale lines. Plain text when nothing stands out.
 */
export function guessPastedLanguage(text: string): IPastedLanguage {
	const sample = text.length > SAMPLE_CHARS ? text.slice(0, SAMPLE_CHARS) : text;
	const trimmed = (text.length > SAMPLE_CHARS ? sample : text).trim();
	if (!trimmed) {
		return PLAIN;
	}
	const lines = sample.split(/\r?\n/).slice(0, SAMPLE_LINES);
	const nonEmpty = lines.filter(line => line.trim());
	const pick = (key: LanguageKey) => LANGUAGES[key];

	const json = looksLikeJson(text, text.length > SAMPLE_CHARS ? text.trim() : trimmed);
	if (json === 'parsed') {
		return pick('json');
	}
	if (nonEmpty.length >= 2 && share(nonEmpty, line => /^\s*\{.*\}\s*$/.test(line)) >= 0.9) {
		return pick('jsonl');
	}
	if (json) {
		return pick('json');
	}
	if (/^<\?xml\b/i.test(trimmed)) {
		return pick('xml');
	}
	if (/^(?:<!doctype html|<html\b)/i.test(trimmed) || (/^<[a-z][\w-]*[\s>]/i.test(trimmed) && /<\/(?:div|body|head|span|p|section|template)>/i.test(sample))) {
		return pick('html');
	}
	if (/^<[a-z][\w:-]*[\s>]/i.test(trimmed) && /<\/[\w:-]+>\s*$/.test(trimmed)) {
		return pick('xml');
	}
	if (/^(?:diff --git |--- a\/|Index: |@@ -\d+(?:,\d+)? \+\d+)/m.test(sample) && /^@@ /m.test(sample)) {
		return pick('diff');
	}
	const timestamped = share(nonEmpty, line => /^\W{0,3}(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\d{2}:\d{2}:\d{2}[.,]\d+|[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2})/.test(line));
	const levelled = share(nonEmpty, line => /\b(?:INFO|WARN(?:ING)?|ERROR|DEBUG|TRACE|FATAL)\b/.test(line));
	const traced = share(nonEmpty, line => /^\s+at .+[(:]\d+|^Traceback \(most recent call last\)|^\s+File ".+", line \d+/.test(line));
	if (timestamped >= 0.4 || levelled >= 0.5 || traced >= 0.3) {
		return pick('log');
	}
	if (delimited(lines, '\t')) {
		return pick('tsv');
	}
	if (delimited(lines, ',') && share(nonEmpty, line => /[;{}()]\s*$/.test(line)) < 0.2) {
		return pick('csv');
	}
	if (/^#!.*\b(?:ba|z|da|k)?sh\b/.test(trimmed)) {
		return pick('shell');
	}
	if (/^#!.*\bpython/.test(trimmed)) {
		return pick('python');
	}
	if (/^#!.*\bnode\b/.test(trimmed)) {
		return pick('javascript');
	}

	// Code: count each language's tell-tale lines and take the clear winner.
	const scores: Partial<Record<LanguageKey, number>> = {};
	const score = (key: LanguageKey, pattern: RegExp, weight = 1) => {
		const hits = nonEmpty.filter(line => pattern.test(line)).length;
		if (hits) {
			scores[key] = (scores[key] ?? 0) + hits * weight;
		}
	};
	// Types are what tell TypeScript from JavaScript; the rest of their lines look the same.
	score('typescript', /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace)\s+\w+/, 3);
	score('typescript', /(?:[(,]\s*|\b(?:const|let|var|readonly|private|public|protected)\s+)\w+\??:\s*(?:string|number|boolean|unknown|any|never|readonly\s|Promise<|Record<|Array<|[A-Z]\w*[<[,)=;])|\):\s*(?:string|number|boolean|void|unknown|Promise<|[A-Z]\w*)/, 2);
	const typed = scores.typescript ?? 0;
	score(typed ? 'typescript' : 'javascript', /^\s*(?:import\s.+\sfrom\s+['"]|export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)|module\.exports|require\(['"])/);
	score(typed ? 'typescript' : 'javascript', /^\s*(?:const|let|var)\s+\w+\s*=|=>\s*[{(]?/);
	score('python', /^\s*(?:def|class)\s+\w+.*:\s*$|^\s*(?:from\s+[\w.]+\s+)?import\s+[\w.]+(?:\s+as\s+\w+)?\s*$|^\s*(?:elif|except|with)\b.*:\s*$|^if __name__ == /, 2);
	score('python', /^\s*self\.\w+|^\s*@\w+(?:\.\w+)*(?:\(.*\))?\s*$/);
	score('go', /^package\s+\w+\s*$|^func\s+(?:\(\w+\s+\*?\w+\)\s+)?\w+\(|:=\s|^\s*import\s+\($/, 3);
	score('rust', /^\s*(?:pub(?:\(crate\))?\s+)?(?:fn|struct|enum|impl|trait|mod|use)\s+[\w:<]|\blet\s+mut\b|->\s*(?:Result|Option|Self|&?\w+)\s*\{/, 3);
	score('java', /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:class|interface|void|[A-Z]\w*(?:<[^>]*>)?)\s+\w+|^\s*package\s+[\w.]+;\s*$|^\s*import\s+[\w.]+(?:\.\*)?;\s*$|System\.out\.println/, 2);
	score('csharp', /^\s*using\s+[\w.]+;\s*$|^\s*namespace\s+[\w.]+|\bpublic\s+(?:async\s+)?(?:Task|void|string|int)\s+\w+\(|Console\.WriteLine/, 2);
	score('cpp', /^\s*#include\s+[<"]|\bstd::|^\s*template\s*<|^\s*(?:int|void)\s+main\s*\(/, 3);
	score('sql', /^\s*(?:SELECT\s.+\sFROM\b|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|INDEX|VIEW)\b|ALTER\s+TABLE\b|WITH\s+\w+\s+AS\s*\()/i, 3);
	score('shell', /^\s*(?:\$\s+\w|export\s+\w+=|(?:sudo|npm|yarn|pnpm|git|cd|echo|curl|brew|apt(?:-get)?)\s)/);
	score('css', /^\s*[.#@:]?[\w-]+(?:[\s>+~,.#:[\]="'\w-]*)\s*\{\s*$|^\s*[\w-]+\s*:\s*[^;{}]+;\s*$/);
	score('markdown', /^#{1,6}\s+\S|^```|^\s*[-*]\s+\[[ x]\]|^\s*\d+\.\s+\S|\[[^\]]+\]\([^)]+\)/);
	score('yaml', /^\s*[\w.-]+:(?:\s+[^{};]*)?$|^\s*-\s+[\w.-]+:\s/);

	// YAML and Markdown keys look like any `name: value` line; they only win in their own files.
	if (scores.yaml && (/[;{}]\s*$/m.test(sample) || (scores.python ?? 0) + (scores.go ?? 0) + (scores.typescript ?? 0) > 2)) {
		scores.yaml = 0;
	}
	let best: LanguageKey | undefined;
	let bestScore = 0;
	for (const [key, value] of Object.entries(scores) as [LanguageKey, number][]) {
		if (value > bestScore) {
			best = key;
			bestScore = value;
		}
	}
	const needed = Math.max(2, Math.min(8, nonEmpty.length * 0.05));
	if (!best || bestScore < needed) {
		return PLAIN;
	}
	if (best === 'yaml' && share(nonEmpty, line => /^\s*(?:[\w.-]+:|-\s|#)/.test(line)) < 0.6) {
		return PLAIN;
	}
	return pick(best);
}

/** The folded paste's saved name: `pasted-text.json`, so tools and editors know its type. */
export function pastedFileName(language: IPastedLanguage): string {
	return `pasted-text.${language.ext}`;
}

/** `Pasted text · 48 KB · 1,203 lines`: the chip's whole label for assistive tech and tests. */
export function pastedChipSummary(size: string, lines: number | undefined, language?: IPastedLanguage): string {
	return ['Pasted text', language && language.id !== 'plaintext' ? language.label : undefined, size, lines !== undefined ? formatLineCount(lines) : undefined].filter(Boolean).join(' · ');
}
