/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { braceDelta, escapeRegExp, fillTestEnds, IOpenTest, IStaticTest, ITestAdapter, missingToolchain, pruneEmptySuites, shellQuote, splitSelection } from './testAdapter.js';

/** Top-level `func TestX(t *testing.T)` functions of a Go test file. */
export function parseGoTests(text: string): IStaticTest[] {
	const tests: IStaticTest[] = [];
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index++) {
		const match = /^func\s+(Test\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)/.exec(lines[index]);
		if (match && (match[1] === 'Test' || /^Test[^a-z]/.test(match[1])) && match[1] !== 'TestMain') {
			tests.push({ name: match[1], kind: 'test', line: index + 1, endLine: index + 1, children: [] });
		}
	}
	fillTestEnds(tests, lines.length);
	return tests;
}

function packageOf(file: string): string {
	return `./${file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.'}`.replace(/\/\.$/, '');
}

/** `-run` takes one pattern per level of `Test/subtest`. */
function goRunPattern(paths: readonly (readonly string[])[]): string {
	const level = (index: number) => [...new Set(paths.map(path => path[index]).filter((name): name is string => name !== undefined))];
	const tops = `^(?:${level(0).map(escapeRegExp).join('|')})$`;
	// Subtests narrow the run only when every selection names one: go applies a level's pattern to all tests.
	const subs = paths.every(path => path.length > 1) ? level(1) : [];
	// go rewrites spaces in a subtest's name to underscores.
	return subs.length ? `${tops}/^(?:${subs.map(name => escapeRegExp(name.replace(/ /g, '_'))).join('|')})$` : tops;
}

export const goAdapter: ITestAdapter = {
	id: 'go',
	label: 'go test',
	family: 'go',
	globs: ['**/*_test.go'],
	// go.work only gathers modules: each module's go.mod is its project, and go finds the workspace file itself.
	markers: ['go.mod'],
	isTestFile: relative => relative.endsWith('_test.go'),
	detect(folder) {
		const manifest = folder.files.get('go.mod');
		if (manifest === undefined) {
			return undefined;
		}
		const module = /^module\s+(\S+)/m.exec(manifest)?.[1];
		return module ? { data: { module } } : {};
	},
	parse: text => parseGoTests(text),
	selectsFiles: false,
	variants: 'subpath',
	coverage: true,
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const { files, named, allNamed } = splitSelection(selection);
		const packages = files.length ? [...new Set(files.map(packageOf))] : ['./...'];
		const coverageFile = options.coverage ? `${options.reportFile}.cover` : undefined;
		return {
			// The JSON events are the report and the live results; Volt prints the text they carry.
			command: ['go', 'test', '-json', ...(coverageFile ? [`-coverprofile=${q(coverageFile)}`] : []), ...(allNamed ? ['-run', q(goRunPattern(named.map(item => item.path)))] : []), ...packages.map(q)].join(' '),
			report: { kind: 'stdout' },
			format: 'go-json',
			stream: 'go-json',
			...(coverageFile ? { coverageFile } : {}),
		};
	},
	missing: (output, exitCode, options) => missingToolchain(output, exitCode, options.windows, { go: 'Go (the go command)' }),
	debug(selection, options) {
		const { files, named, allNamed } = splitSelection(selection);
		const packages = [...new Set(files.map(packageOf))];
		if (packages.length !== 1) {
			return 'Go tests are debugged one package at a time: pick a test, a file or a folder that is one package.';
		}
		return {
			type: 'go',
			extension: 'the Go extension (golang.go)',
			config: { type: 'go', request: 'launch', mode: 'test', program: `${options.cwd.replace(/[\\/]$/, '')}/${packages[0].replace(/^\.\/?/, '')}`.replace(/\/$/, ''), args: ['-test.v', ...(allNamed ? ['-test.run', goRunPattern(named.map(item => item.path))] : [])] },
		};
	},
	// A package's tests cover the package's files.
	affects: (changed, testFile) => changed.endsWith('.go') && packageOf(changed) === packageOf(testFile),
};

/** `#[test]` functions of a Rust file, nested in their `mod` blocks (names are cargo test paths' last parts). */
export function parseRustTests(text: string): IStaticTest[] {
	const roots: IStaticTest[] = [];
	const stack: { node: IOpenTest; depth: number }[] = [];
	let depth = 0;
	let pendingTest = false;
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const trimmed = line.trim();
		if (/^#\[(?:[\w:]+::)?(?:test|rstest|test_case|quickcheck|proptest)\b/.test(trimmed)) {
			pendingTest = true;
		}
		const mod = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*\{/.exec(line);
		if (mod) {
			const node: IOpenTest = { name: mod[1], kind: 'suite', line: index + 1, endLine: index + 1, children: [] };
			(stack.at(-1)?.node.children ?? roots).push(node);
			stack.push({ node, depth });
		}
		const fn = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/.exec(line);
		if (fn && pendingTest) {
			(stack.at(-1)?.node.children ?? roots).push({ name: fn[1], kind: 'test', line: index + 1, endLine: index + 1, children: [] });
			pendingTest = false;
		}
		depth += braceDelta(line, true, true);
		while (stack.length && depth <= stack[stack.length - 1].depth) {
			stack.pop()!.node.endLine = index + 1;
		}
	}
	const pruned = pruneEmptySuites(roots);
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

/** The crate a Cargo.toml declares; undefined for a virtual workspace manifest (no `[package]`). */
export function cargoPackageName(manifest: string | undefined): string | undefined {
	const section = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(manifest ?? '');
	return section ? /^\s*name\s*=\s*"([^"]+)"/m.exec(section[1])?.[1] : undefined;
}

export const cargoAdapter: ITestAdapter = {
	id: 'cargo',
	label: 'cargo test',
	family: 'rust',
	globs: ['**/*.rs'],
	contentPattern: '#\\[(?:[\\w:]+::)?(?:test|rstest|test_case|quickcheck|proptest)\\b',
	markers: ['Cargo.toml'],
	isTestFile: relative => relative.endsWith('.rs'),
	// A workspace's own manifest without a package holds no tests: its member crates are the projects.
	detect(folder) {
		const name = cargoPackageName(folder.files.get('Cargo.toml'));
		return name ? { data: { package: name } } : undefined;
	},
	parse: text => text.includes('#[') ? parseRustTests(text) : [],
	selectsFiles: false,
	prefix: rustModulePath,
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const { named, allNamed, files } = splitSelection(selection);
		// A test runs by its exact path; a module by the path its tests start with.
		const exact = allNamed && named.every(item => item.kind !== 'suite');
		const filters = allNamed ? [...new Set(named.map(item => item.path.join('::')))] : [];
		// An integration test file is its own target: `--test name`.
		const targets = selection.length && files.every(file => /(?:^|\/)tests\/[^/]+\.rs$/.test(file)) ? [...new Set(files.map(file => file.split('/').pop()!.replace(/\.rs$/, '')))].flatMap(name => ['--test', q(name)]) : [];
		return {
			command: [
				'cargo', 'test', ...(options.data?.package ? ['-p', q(options.data.package)] : []), '--no-fail-fast', ...targets,
				...(filters.length ? ['--', ...filters.map(q), ...(exact ? ['--exact'] : [])] : []),
			].join(' '),
			report: { kind: 'stdout' },
			format: 'cargo-text',
			stream: 'cargo-text',
		};
	},
	missing: (output, exitCode, options) => missingToolchain(output, exitCode, options.windows, { cargo: 'Rust (cargo)' }),
	debug(selection, options) {
		const { named, allNamed } = splitSelection(selection);
		// CodeLLDB builds the test binary itself from a cargo invocation and runs the selected test in it.
		return {
			type: 'lldb',
			extension: 'the CodeLLDB extension (vadimcn.vscode-lldb)',
			config: {
				type: 'lldb', request: 'launch', cwd: options.cwd,
				cargo: { args: ['test', '--no-run', ...(options.data?.package ? ['-p', options.data.package] : [])] },
				args: allNamed ? [...new Set(named.map(item => item.path.join('::'))), ...(named.every(item => item.kind !== 'suite') ? ['--exact'] : []), '--nocapture'] : ['--nocapture'],
			},
		};
	},
	affects: (changed, testFile) => changed.endsWith('.rs') && (changed === testFile || /(?:^|\/)tests\//.test(testFile)),
};
