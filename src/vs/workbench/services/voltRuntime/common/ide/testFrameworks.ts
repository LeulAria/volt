/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Volt's own test runner for projects without a test extension: which framework a test file
 * belongs to, the tests a file declares (read statically, so discovery never runs project code),
 * and the command that runs a selection with a machine-readable report. Pure; the window's test
 * controller does the I/O.
 */

export type TestFramework = 'vitest' | 'jest' | 'mocha' | 'pytest' | 'go' | 'cargo';

export const TEST_FRAMEWORK_LABELS: Readonly<Record<TestFramework, string>> = {
	vitest: 'Vitest',
	jest: 'Jest',
	mocha: 'Mocha',
	pytest: 'pytest',
	go: 'go test',
	cargo: 'cargo test',
};

/** Globs (relative, `**` style) of files that can hold tests, per language family. */
export const TEST_FILE_GLOBS = {
	js: '**/{*.test,*.spec,*_test,*-test}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}',
	jsDir: '**/{__tests__,test,tests}/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}',
	python: '**/{test_*.py,*_test.py}',
	go: '**/*_test.go',
	rust: '**/*.rs',
} as const;

export const TEST_EXCLUDE_GLOB = '**/{node_modules,.git,dist,out,build,target,.venv,venv,__pycache__,.next,coverage,vendor}/**';

/** Project marker files, nearest first, per family. */
export const PROJECT_MARKERS = {
	js: ['package.json'],
	python: ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'setup.py'],
	go: ['go.mod'],
	rust: ['Cargo.toml'],
} as const;

export type TestFamily = keyof typeof PROJECT_MARKERS;

export function familyOf(path: string): TestFamily | undefined {
	if (/\.(?:[cm]?[jt]sx?)$/.test(path)) {
		return 'js';
	}
	if (path.endsWith('.py')) {
		return 'python';
	}
	if (path.endsWith('_test.go')) {
		return 'go';
	}
	if (path.endsWith('.rs')) {
		return 'rust';
	}
	return undefined;
}

/** Whether a path inside a JS project is a test file (by name, or by living in a test folder). */
export function isJsTestPath(relative: string): boolean {
	const path = relative.replace(/\\/g, '/');
	if (/(?:^|\/)node_modules\//.test(path)) {
		return false;
	}
	return /[._-](?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)(?:__tests__|tests?)\/.+\.[cm]?[jt]sx?$/.test(path);
}

/** The JS framework a package uses, from its package.json text; undefined when none of ours. */
export function detectJsFramework(packageJson: string | undefined): TestFramework | undefined {
	if (!packageJson) {
		return undefined;
	}
	let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>; jest?: unknown } | undefined;
	try {
		parsed = JSON.parse(packageJson) as typeof parsed;
	} catch {
		return undefined;
	}
	const deps = { ...parsed?.dependencies, ...parsed?.devDependencies };
	const testScript = parsed?.scripts?.test ?? '';
	if ('vitest' in deps || /\bvitest\b/.test(testScript)) {
		return 'vitest';
	}
	if ('jest' in deps || 'ts-jest' in deps || 'react-scripts' in deps || parsed?.jest !== undefined || /\bjest\b/.test(testScript)) {
		return 'jest';
	}
	if ('mocha' in deps || /\bmocha\b/.test(testScript)) {
		return 'mocha';
	}
	return undefined;
}

export interface IStaticTest {
	readonly name: string;
	readonly kind: 'suite' | 'test';
	/** 1-based lines. */
	readonly line: number;
	readonly endLine: number;
	readonly children: IStaticTest[];
}

interface IOpenSuite {
	readonly node: IStaticTest & { endLine: number };
	readonly depth: number;
}

const JS_DECL = /^\s*(?:(describe|suite|context|fdescribe|xdescribe)|(it|test|specify|fit|xit|xtest))(?:\.(?:only|skip|todo|concurrent|sequential|fails|skipIf\([^)]*\)|runIf\([^)]*\)|each\s*(?:\([^)]*\)|`[^`]*`)))*\s*\(\s*(['"`])((?:\\.|(?!\3).)*)\3/;

/** Brace depth change of a line, ignoring braces inside strings and line comments. */
function braceDelta(line: string): number {
	let delta = 0;
	let quote: string | undefined;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			if (ch === '\\') {
				i++;
			} else if (ch === quote) {
				quote = undefined;
			}
			continue;
		}
		if (ch === '/' && line[i + 1] === '/') {
			break;
		}
		if (ch === '"' || ch === '\'' || ch === '`') {
			quote = ch;
		} else if (ch === '{' || ch === '(') {
			delta++;
		} else if (ch === '}' || ch === ')') {
			delta--;
		}
	}
	return delta;
}

/** describe/it/test blocks of a JS/TS test file, nested, by line. Dynamic names are kept as written. */
export function parseJsTests(text: string): IStaticTest[] {
	const roots: IStaticTest[] = [];
	const stack: IOpenSuite[] = [];
	let depth = 0;
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const match = JS_DECL.exec(line);
		if (match) {
			const node = { name: match[4].replace(/\\(.)/g, '$1'), kind: match[1] ? 'suite' as const : 'test' as const, line: index + 1, endLine: index + 1, children: [] as IStaticTest[] };
			(stack.at(-1)?.node.children ?? roots).push(node);
			if (node.kind === 'suite') {
				stack.push({ node, depth });
			}
		}
		depth += braceDelta(line);
		while (stack.length && depth <= stack[stack.length - 1].depth) {
			stack.pop()!.node.endLine = index + 1;
		}
	}
	for (const open of stack) {
		open.node.endLine = lines.length;
	}
	fillTestEnds(roots, lines.length);
	return roots;
}

/** A test ends where its next sibling starts (or its suite ends). Good enough for ranges and file:line. */
function fillTestEnds(nodes: IStaticTest[], end: number): void {
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i] as IStaticTest & { endLine: number };
		if (node.kind === 'test') {
			node.endLine = Math.max(node.line, (nodes[i + 1]?.line ?? end + 1) - 1);
		} else {
			fillTestEnds(node.children, node.endLine);
		}
	}
}

/** Test classes and test functions of a pytest file, nested by indentation. */
export function parsePythonTests(text: string): IStaticTest[] {
	const roots: IStaticTest[] = [];
	const stack: { node: IStaticTest & { endLine: number }; indent: number }[] = [];
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line.trim() || line.trim().startsWith('#')) {
			continue;
		}
		const indent = line.length - line.trimStart().length;
		while (stack.length && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}
		const cls = /^(\s*)class\s+(Test\w*)\s*[(:]/.exec(line);
		const fn = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(line);
		const parent = stack.at(-1)?.node;
		if (cls) {
			const node = { name: cls[2], kind: 'suite' as const, line: index + 1, endLine: index + 1, children: [] as IStaticTest[] };
			(parent?.children ?? roots).push(node);
			stack.push({ node, indent });
		} else if (fn && (!parent || parent.kind === 'suite')) {
			(parent?.children ?? roots).push({ name: fn[2], kind: 'test', line: index + 1, endLine: index + 1, children: [] });
		}
		for (const open of stack) {
			open.node.endLine = index + 1;
		}
	}
	fillTestEnds(roots, lines.length);
	return roots;
}

/** Top-level `func TestX(t *testing.T)` functions of a Go test file. */
export function parseGoTests(text: string): IStaticTest[] {
	const tests: IStaticTest[] = [];
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index++) {
		const match = /^func\s+(Test\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)/.exec(lines[index]);
		if (match && (match[1] === 'Test' || /^Test[^a-z]/.test(match[1]))) {
			tests.push({ name: match[1], kind: 'test', line: index + 1, endLine: index + 1, children: [] });
		}
	}
	fillTestEnds(tests, lines.length);
	return tests;
}

/** `#[test]` functions of a Rust file, nested in their `mod` blocks (names are cargo test paths' last parts). */
export function parseRustTests(text: string): IStaticTest[] {
	const roots: IStaticTest[] = [];
	const stack: { node: IStaticTest & { endLine: number }; depth: number }[] = [];
	let depth = 0;
	let pendingTest = false;
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const trimmed = line.trim();
		if (/^#\[(?:[\w:]+::)?test\b/.test(trimmed)) {
			pendingTest = true;
		}
		const mod = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*\{/.exec(line);
		if (mod) {
			const node = { name: mod[1], kind: 'suite' as const, line: index + 1, endLine: index + 1, children: [] as IStaticTest[] };
			(stack.at(-1)?.node.children ?? roots).push(node);
			stack.push({ node, depth });
		}
		const fn = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/.exec(line);
		if (fn && pendingTest) {
			(stack.at(-1)?.node.children ?? roots).push({ name: fn[1], kind: 'test', line: index + 1, endLine: index + 1, children: [] });
			pendingTest = false;
		}
		depth += braceDelta(line);
		while (stack.length && depth <= stack[stack.length - 1].depth) {
			stack.pop()!.node.endLine = index + 1;
		}
	}
	const prune = (nodes: IStaticTest[]): IStaticTest[] => nodes.filter(node => node.kind === 'test' || (node.children.splice(0, node.children.length, ...prune(node.children)), node.children.length > 0));
	const pruned = prune(roots);
	fillTestEnds(pruned, lines.length);
	return pruned;
}

/**
 * The module path cargo prefixes to tests in a source file: `src/net/http.rs` holds
 * `net::http::...`; crate roots, `mod.rs` and integration tests (`tests/x.rs`, their own crate) add nothing.
 */
export function rustModulePath(relative: string): string[] {
	const path = relative.replace(/\\/g, '/');
	const src = path.lastIndexOf('src/');
	if (src < 0 || /(?:^|\/)tests\//.test(path.slice(0, src))) {
		return [];
	}
	const parts = path.slice(src + 4).replace(/\.rs$/, '').split('/');
	if (parts.length === 1 && (parts[0] === 'lib' || parts[0] === 'main')) {
		return [];
	}
	if (parts.at(-1) === 'mod') {
		parts.pop();
	}
	return parts[0] === 'bin' ? [] : parts;
}

export function parseTests(family: TestFamily, text: string): IStaticTest[] {
	switch (family) {
		case 'js': return parseJsTests(text);
		case 'python': return parsePythonTests(text);
		case 'go': return parseGoTests(text);
		case 'rust': return text.includes('#[') ? parseRustTests(text) : [];
	}
}

// --- Running ---------------------------------------------------------------------------------

/** One test selected to run: its file (relative to the project root) and its name path in that file. */
export interface ITestSelection {
	readonly file: string;
	/** Suite names then the test name; empty for the whole file. */
	readonly path: readonly string[];
}

export interface ITestCommand {
	/** A shell command line, run in the project root. */
	readonly command: string;
	/** Where the report lands (absolute). */
	readonly reportFile: string;
	readonly format: TestReportFormat;
}

export type TestReportFormat = 'jest-json' | 'mocha-json' | 'junit' | 'go-json' | 'cargo-text';

/** Quotes one shell argument for the platform shell (POSIX sh or cmd.exe). */
export function shellQuote(value: string, windows: boolean): string {
	if (/^[\w./:=@%+-]+$/.test(value)) {
		return value;
	}
	return windows ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The command that runs `selection` (empty: the whole project) with a report Volt can read.
 * `python` is the interpreter to use for pytest (a project venv when there is one).
 */
export function buildTestCommand(framework: TestFramework, selection: readonly ITestSelection[], options: { readonly reportFile: string; readonly windows: boolean; readonly python?: string; readonly coverage?: boolean }): ITestCommand {
	const q = (value: string) => shellQuote(value, options.windows);
	const files = [...new Set(selection.map(item => item.file))];
	const named = selection.filter(item => item.path.length);
	// Tests picked inside files run by name; whole files run by path.
	const namePattern = named.length && named.length === selection.length
		? `^(?:${[...new Set(named.map(item => item.path.map(escapeRegExp).join(' ')))].join('|')})$`
		: undefined;
	switch (framework) {
		case 'vitest':
			return {
				command: ['npx', '--no-install', 'vitest', 'run', '--reporter=json', `--outputFile=${q(options.reportFile)}`, ...(options.coverage ? ['--coverage'] : []), ...files.map(q), ...(namePattern ? ['-t', q(namePattern)] : [])].join(' '),
				reportFile: options.reportFile,
				format: 'jest-json',
			};
		case 'jest':
			return {
				command: ['npx', '--no-install', 'jest', '--json', `--outputFile=${q(options.reportFile)}`, '--testLocationInResults', ...(options.coverage ? ['--coverage'] : []), ...(files.length ? ['--runTestsByPath', ...files.map(q)] : []), ...(namePattern ? ['-t', q(namePattern)] : [])].join(' '),
				reportFile: options.reportFile,
				format: 'jest-json',
			};
		case 'mocha':
			return {
				command: ['npx', '--no-install', 'mocha', '--reporter', 'json', '--reporter-option', `output=${q(options.reportFile)}`, ...files.map(q), ...(namePattern ? ['--grep', q(namePattern)] : [])].join(' '),
				reportFile: options.reportFile,
				format: 'mocha-json',
			};
		case 'pytest': {
			const ids = selection.map(item => [item.file, ...item.path].join('::'));
			return {
				command: [q(options.python ?? 'python3'), '-m', 'pytest', '-q', '-rN', `--junitxml=${q(options.reportFile)}`, ...ids.map(q)].join(' '),
				reportFile: options.reportFile,
				format: 'junit',
			};
		}
		case 'go': {
			const packages = files.length ? [...new Set(files.map(file => `./${file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.'}`.replace(/\/\.$/, '')))] : ['./...'];
			const names = [...new Set(named.map(item => item.path[0]))];
			const run = names.length && named.length === selection.length ? ['-run', q(`^(?:${names.map(escapeRegExp).join('|')})$`)] : [];
			// The JSON events go to the report file; build errors (stderr) still stream to the user.
			return { command: [...['go', 'test', '-json', ...(options.coverage ? ['-cover'] : []), ...run, ...packages.map(q)], '>', q(options.reportFile)].join(' '), reportFile: options.reportFile, format: 'go-json' };
		}
		case 'cargo': {
			const filters = named.length === selection.length ? [...new Set(named.map(item => item.path.join('::')))] : [];
			return { command: ['cargo', 'test', '--no-fail-fast', ...(filters.length ? ['--', ...filters.map(q), '--exact'] : []), '>', q(options.reportFile)].join(' '), reportFile: options.reportFile, format: 'cargo-text' };
		}
	}
}
