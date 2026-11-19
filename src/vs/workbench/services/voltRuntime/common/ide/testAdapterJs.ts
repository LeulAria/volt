/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { braceDelta, escapeRegExp, fillTestEnds, IDetectedProject, IFolderProbe, IMissingTool, IOpenTest, IRuntimeCandidate, IStaticTest, ITestAdapter, ITestCommandOptions, ITestSelection, parseJson, shellQuote, splitSelection, TestFramework } from './testAdapter.js';

const JS_EXTENSIONS = '{js,jsx,ts,tsx,mjs,cjs,mts,cts}';
const JS_GLOBS = [`**/{*.test,*.spec,*_test,*-test,*.e2e,*.e2e-spec}.${JS_EXTENSIONS}`, `**/{__tests__,test,tests,e2e}/**/*.${JS_EXTENSIONS}`] as const;
const CONFIG_EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'] as const;
const configs = (name: string, extra: readonly string[] = []) => [...CONFIG_EXTENSIONS.map(extension => `${name}.${extension}`), ...extra];
const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json'] as const;

/** Whether a path inside a JS project is a test file (by name, or by living in a test folder). */
export function isJsTestPath(relative: string): boolean {
	const path = relative.replace(/\\/g, '/');
	if (/(?:^|\/)node_modules\//.test(path) || /\.d\.[cm]?ts$/.test(path)) {
		return false;
	}
	return /[._-](?:test|spec|e2e|e2e-spec)\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)(?:__tests__|tests?|e2e)\/.+\.[cm]?[jt]sx?$/.test(path);
}

interface IPackageJson {
	readonly dependencies?: Record<string, string>;
	readonly devDependencies?: Record<string, string>;
	readonly scripts?: Record<string, string>;
	readonly jest?: unknown;
	readonly mocha?: unknown;
}

function packageOf(folder: IFolderProbe): { readonly deps: Record<string, string>; readonly testScript: string; readonly json: IPackageJson | undefined } {
	const json = parseJson<IPackageJson>(folder.files.get('package.json'));
	return { deps: { ...json?.dependencies, ...json?.devDependencies }, testScript: Object.entries(json?.scripts ?? {}).filter(([name]) => /^test(?::|$)/.test(name)).map(([, script]) => script).join('\n'), json };
}

function hasAny(folder: IFolderProbe, names: readonly string[]): boolean {
	return names.some(name => folder.files.has(name));
}

function isVitest(folder: IFolderProbe): boolean {
	const { deps, testScript } = packageOf(folder);
	return 'vitest' in deps || /\bvitest\b/.test(testScript) || hasAny(folder, [...configs('vitest.config'), ...configs('vitest.workspace', ['vitest.workspace.json'])])
		|| configs('vite.config').some(name => /\bvitest\b|\btest\s*:/.test(folder.files.get(name) ?? ''));
}

function isJest(folder: IFolderProbe): boolean {
	const { deps, testScript, json } = packageOf(folder);
	return 'jest' in deps || 'ts-jest' in deps || 'react-scripts' in deps || '@jest/core' in deps || json?.jest !== undefined || /\bjest\b/.test(testScript) || hasAny(folder, configs('jest.config', ['jest.config.json']));
}

function isMocha(folder: IFolderProbe): boolean {
	const { deps, testScript, json } = packageOf(folder);
	return 'mocha' in deps || json?.mocha !== undefined || /\bmocha\b/.test(testScript) || hasAny(folder, ['.mocharc.js', '.mocharc.cjs', '.mocharc.mjs', '.mocharc.json', '.mocharc.jsonc', '.mocharc.yml', '.mocharc.yaml']);
}

function isPlaywright(folder: IFolderProbe): boolean {
	const { deps, testScript } = packageOf(folder);
	return '@playwright/test' in deps || /\bplaywright test\b/.test(testScript) || hasAny(folder, configs('playwright.config'));
}

function isNodeTest(folder: IFolderProbe): boolean {
	return /\bnode\b[^\n&|;]*\s--test\b|\btsx\s+--test\b/.test(packageOf(folder).testScript);
}

function isBun(folder: IFolderProbe): boolean {
	return /\bbun\s+test\b/.test(packageOf(folder).testScript) || ((hasAny(folder, ['bun.lock', 'bun.lockb', 'bunfig.toml'])) && folder.files.has('package.json'));
}

/** The JS framework a package uses, from its package.json text; undefined when none of ours. */
export function detectJsFramework(packageJson: string | undefined): TestFramework | undefined {
	if (!packageJson) {
		return undefined;
	}
	const folder: IFolderProbe = { files: new Map([['package.json', packageJson]]) };
	if (!parseJson(packageJson)) {
		return undefined;
	}
	return isVitest(folder) ? 'vitest' : isJest(folder) ? 'jest' : isMocha(folder) ? 'mocha' : isPlaywright(folder) ? 'playwright' : isNodeTest(folder) ? 'node' : isBun(folder) ? 'bun' : undefined;
}

/** The folder Playwright looks for tests in, from its config's text (`testDir: './e2e'`). */
export function playwrightTestDir(config: string | undefined): string | undefined {
	const match = /\btestDir\s*:\s*(['"`])([^'"`]+)\1/.exec(config ?? '');
	return match ? match[2].replace(/^\.\//, '').replace(/\/$/, '') : undefined;
}

const E2E_PATH = /(?:^|\/)(?:e2e|playwright|tests-e2e|e2e-tests|integration-tests\/playwright)\/|\.(?:e2e|pw)\.[cm]?[jt]sx?$|\.e2e-spec\.[cm]?[jt]sx?$/;

/** Which files Playwright runs in a package: its testDir when the config names one; next to a unit-test framework, the e2e folders only. */
function playwrightOwns(folder: IFolderProbe): ((relative: string) => boolean) | undefined {
	const testDir = configs('playwright.config').map(name => playwrightTestDir(folder.files.get(name))).find(dir => dir !== undefined);
	if (testDir && testDir !== '.') {
		return relative => relative.startsWith(`${testDir}/`);
	}
	return isVitest(folder) || isJest(folder) || isMocha(folder) || isNodeTest(folder) ? relative => E2E_PATH.test(relative) : undefined;
}

function packageManager(folder: IFolderProbe): string {
	return folder.files.has('pnpm-lock.yaml') ? 'pnpm' : folder.files.has('yarn.lock') ? 'yarn' : folder.files.has('bun.lock') || folder.files.has('bun.lockb') ? 'bun' : 'npm';
}

function jsData(folder: IFolderProbe): Record<string, string> {
	return { packageManager: packageManager(folder) };
}

// --- Static parsing --------------------------------------------------------------------------

const JS_MODIFIERS = '(?:\\.(?:only|skip|todo|concurrent|sequential|serial|parallel|fails|fixme|slow|skipIf\\([^)]*\\)|runIf\\([^)]*\\)|if\\([^)]*\\)|each\\s*(?:\\([^)]*\\)|`[^`]*`)))*';
const JS_DECL = new RegExp(`^\\s*(?:(?:await\\s+)?(?:(describe|suite|context|fdescribe|xdescribe|test\\.describe)|(it|test|specify|fit|xit|xtest|bench)))${JS_MODIFIERS}\\s*\\(\\s*(['"\`])((?:\\\\.|(?!\\3).)*)\\3`);

/** describe/it/test blocks of a JS/TS test file, nested, by line. Dynamic names are kept as written. */
export function parseJsTests(text: string): IStaticTest[] {
	const roots: IStaticTest[] = [];
	const stack: { readonly node: IOpenTest; readonly depth: number }[] = [];
	let depth = 0;
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const match = JS_DECL.exec(line);
		if (match) {
			const node: IOpenTest = { name: match[4].replace(/\\(.)/g, '$1'), kind: match[1] ? 'suite' : 'test', line: index + 1, endLine: index + 1, children: [] };
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

// --- Commands --------------------------------------------------------------------------------

/**
 * The pattern runners match against a test's full name (suites then test, joined by `separator`).
 * A suite matches everything under it; `%s`-style and template placeholders match anything.
 */
export function jsNamePattern(named: readonly ITestSelection[], separator = ' '): string {
	const one = (item: ITestSelection) => {
		const name = item.path.map(part => escapeRegExp(part).replace(/%[sdifjoOp#]|\\\$\\\{[^}]*\\\}|\\\$[\w.]+/g, '.*')).join(escapeRegExp(separator));
		return item.kind === 'suite' ? `${name}(?:${escapeRegExp(separator)}|$)` : `${name}$`;
	};
	return `^(?:${[...new Set(named.map(one))].join('|')})`;
}

function bin(name: string): (windows: boolean) => readonly IRuntimeCandidate[] {
	return windows => [{ exists: [`node_modules/.bin/${name}${windows ? '.cmd' : ''}`], argv: ['{}'] }, { argv: ['npx', '--no-install', name] }];
}

function runner(options: ITestCommandOptions, fallback: readonly string[]): string[] {
	return (options.runtime ?? fallback).map(part => shellQuote(part, options.windows));
}

function install(options: ITestCommandOptions, extra = ''): string {
	const manager = options.data?.packageManager ?? 'npm';
	return extra ? `${manager} ${manager === 'npm' ? 'install -D' : 'add -D'} ${extra}` : `${manager} install`;
}

/** node_modules not installed, or the framework's package is not in them. */
function missingJs(name: string): (output: string, exitCode: number | null, options: ITestCommandOptions) => IMissingTool | undefined {
	return (output, exitCode, options) => {
		if (/npx canceled due to missing packages|could not determine executable to run|npm ERR! canceled|ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL|command not found: (?:npx|node)\b|(?:npx|node): (?:command )?not found/.test(output) && exitCode !== 0) {
			if (/(?:npx|node)\b.*not found|not found: (?:npx|node)/.test(output)) {
				return { what: 'Node.js (node and npx)', install: options.windows ? 'winget install OpenJS.NodeJS' : 'brew install node (or https://nodejs.org)' };
			}
			return { what: `${name} (this project's node_modules)`, install: install(options) };
		}
		const dependency = /MISSING DEPENDENCY\s+Cannot find dependency '([^']+)'|Cannot find (?:module|package) '(@vitest\/coverage-[\w-]+|@playwright\/test|jest-environment-[\w-]+|ts-node|ts-jest|tsx)'/.exec(output);
		if (dependency && exitCode !== 0) {
			return { what: dependency[1] ?? dependency[2], install: install(options, dependency[1] ?? dependency[2]) };
		}
		if (/Executable doesn't exist at .*ms-playwright|Please run the following command to download new browsers/.test(output)) {
			return { what: 'Playwright\'s browsers', install: 'npx playwright install' };
		}
		return undefined;
	};
}

/** `VAR=value command` for the platform shell. */
export function withEnv(env: Readonly<Record<string, string>>, command: string, windows: boolean): string {
	const pairs = Object.entries(env);
	if (!pairs.length) {
		return command;
	}
	return windows ? `${pairs.map(([name, value]) => `set "${name}=${value}"`).join(' && ')} && ${command}` : `${pairs.map(([name, value]) => `${name}=${shellQuote(value, false)}`).join(' ')} ${command}`;
}

function nodeTerminalDebug(adapter: Pick<ITestAdapter, 'command'>): NonNullable<ITestAdapter['debug']> {
	return (selection, options) => {
		const command = adapter.command(selection, { ...options, coverage: false });
		return { type: 'node-terminal', extension: 'the built-in JavaScript Debugger', config: { type: 'node-terminal', request: 'launch', command: command.command, cwd: options.cwd }, report: command.report, format: command.format };
	};
}

const jsBase = {
	family: 'js' as const,
	globs: JS_GLOBS,
	isTestFile: isJsTestPath,
	parse: (text: string) => parseJsTests(text),
	coverage: true,
	// A source file affects the tests beside it and the ones named after it.
	affects: (changed: string, testFile: string) => {
		const stem = (path: string) => path.replace(/\.[cm]?[jt]sx?$/, '').replace(/[._-](?:test|spec)$/, '').split('/').pop() ?? '';
		return stem(changed) === stem(testFile);
	},
};

const PACKAGE_MARKERS = ['package.json', ...LOCKFILES] as const;

export const vitestAdapter: ITestAdapter = {
	...jsBase,
	id: 'vitest',
	label: 'Vitest',
	markers: [...PACKAGE_MARKERS, ...configs('vitest.config'), ...configs('vitest.workspace', ['vitest.workspace.json']), ...configs('vite.config')],
	detect: folder => isVitest(folder) ? { data: jsData(folder) } : undefined,
	runtimes: bin('vitest'),
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const { files, named, allNamed } = splitSelection(selection);
		const coverageFile = options.coverage ? `${options.reportFile}.coverage` : undefined;
		return {
			command: [
				...runner(options, ['npx', '--no-install', 'vitest']), 'run', '--reporter=json', `--outputFile=${q(options.reportFile)}`, '--reporter=verbose',
				...(coverageFile ? ['--coverage', '--coverage.reporter=lcovonly', `--coverage.reportsDirectory=${q(coverageFile)}`] : []),
				...files.map(q), ...(allNamed ? ['-t', q(jsNamePattern(named))] : []),
			].join(' '),
			report: { kind: 'file', path: options.reportFile },
			format: 'jest-json',
			stream: 'vitest-verbose',
			...(coverageFile ? { coverageFile: `${coverageFile}/lcov.info` } : {}),
		};
	},
	missing: missingJs('vitest'),
	debug: (selection, options) => nodeTerminalDebug(vitestAdapter)(selection, options),
};

export const jestAdapter: ITestAdapter = {
	...jsBase,
	id: 'jest',
	label: 'Jest',
	markers: [...PACKAGE_MARKERS, ...configs('jest.config', ['jest.config.json'])],
	detect: folder => isJest(folder) ? { data: jsData(folder) } : undefined,
	runtimes: bin('jest'),
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const { files, named, allNamed } = splitSelection(selection);
		const coverageFile = options.coverage ? `${options.reportFile}.coverage` : undefined;
		return {
			command: [
				...runner(options, ['npx', '--no-install', 'jest']), '--json', `--outputFile=${q(options.reportFile)}`, '--testLocationInResults', '--verbose',
				...(coverageFile ? ['--coverage', '--coverageReporters=lcovonly', `--coverageDirectory=${q(coverageFile)}`] : []),
				...(files.length ? ['--runTestsByPath', ...files.map(q)] : []), ...(allNamed ? ['-t', q(jsNamePattern(named))] : []),
			].join(' '),
			report: { kind: 'file', path: options.reportFile },
			format: 'jest-json',
			stream: 'jest-verbose',
			...(coverageFile ? { coverageFile: `${coverageFile}/lcov.info` } : {}),
		};
	},
	missing: missingJs('jest'),
	debug: (selection, options) => nodeTerminalDebug({ command: (items, opts) => { const command = jestAdapter.command(items, opts); return { ...command, command: `${command.command} --runInBand` }; } })(selection, options),
};

export const mochaAdapter: ITestAdapter = {
	...jsBase,
	id: 'mocha',
	label: 'Mocha',
	coverage: false,
	markers: [...PACKAGE_MARKERS, '.mocharc.js', '.mocharc.cjs', '.mocharc.mjs', '.mocharc.json', '.mocharc.jsonc', '.mocharc.yml', '.mocharc.yaml'],
	detect: folder => isMocha(folder) ? { data: jsData(folder) } : undefined,
	runtimes: bin('mocha'),
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const { files, named, allNamed } = splitSelection(selection);
		return {
			command: [...runner(options, ['npx', '--no-install', 'mocha']), '--reporter', 'json', '--reporter-option', `output=${q(options.reportFile)}`, ...files.map(q), ...(allNamed ? ['--grep', q(jsNamePattern(named))] : [])].join(' '),
			report: { kind: 'file', path: options.reportFile },
			format: 'mocha-json',
		};
	},
	missing: missingJs('mocha'),
	debug: (selection, options) => nodeTerminalDebug(mochaAdapter)(selection, options),
};

export const playwrightAdapter: ITestAdapter = {
	...jsBase,
	id: 'playwright',
	label: 'Playwright',
	coverage: false,
	markers: [...PACKAGE_MARKERS, ...configs('playwright.config')],
	detect(folder): IDetectedProject | undefined {
		if (!isPlaywright(folder)) {
			return undefined;
		}
		const owns = playwrightOwns(folder);
		return { ...(owns ? { owns } : {}), data: jsData(folder) };
	},
	runtimes: bin('playwright'),
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const { files, named, allNamed } = splitSelection(selection);
		// Playwright joins a test's titles with a space for -g, like the unit-test runners.
		const command = [...runner(options, ['npx', '--no-install', 'playwright']), 'test', '--reporter=junit,line', ...files.map(q), ...(allNamed ? ['-g', q(jsNamePattern(named))] : [])].join(' ');
		return { command: withEnv({ PLAYWRIGHT_JUNIT_OUTPUT_NAME: options.reportFile }, command, options.windows), report: { kind: 'file', path: options.reportFile }, format: 'junit-playwright' };
	},
	missing: missingJs('@playwright/test'),
	debug: (selection, options) => nodeTerminalDebug({ command: (items, opts) => { const command = playwrightAdapter.command(items, opts); return { ...command, command: `${command.command} --workers=1` }; } })(selection, options),
};

/** Flags the package's own test script gives node that the tests need to load (a TypeScript loader). */
function nodeLoaderFlags(folder: IFolderProbe): string {
	const script = packageOf(folder).testScript;
	const flags = [...script.matchAll(/--(?:import|loader|require|experimental-loader)[= ]\S+|--experimental-strip-types|--experimental-transform-types/g)].map(match => match[0]);
	return /\btsx\s+--test\b/.test(script) && !flags.length ? '--import tsx' : flags.join(' ');
}

export const nodeTestAdapter: ITestAdapter = {
	...jsBase,
	id: 'node',
	label: 'node --test',
	markers: PACKAGE_MARKERS,
	detect: folder => isNodeTest(folder) ? { data: { ...jsData(folder), loader: nodeLoaderFlags(folder) } } : undefined,
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const { files, named, allNamed } = splitSelection(selection);
		const coverageFile = options.coverage ? `${options.reportFile}.lcov` : undefined;
		return {
			command: [
				'node', ...(options.data?.loader ? options.data.loader.split(' ') : []), '--test', '--test-reporter=junit', `--test-reporter-destination=${q(options.reportFile)}`, '--test-reporter=spec', '--test-reporter-destination=stdout',
				...(coverageFile ? ['--experimental-test-coverage', '--test-reporter=lcov', `--test-reporter-destination=${q(coverageFile)}`] : []),
				// node matches a test by its own name, at any depth: the last name of each selection.
				...(allNamed ? [...new Set(named.map(item => q(`--test-name-pattern=^${escapeRegExp(item.path.at(-1)!)}$`)))] : []),
				...files.map(q),
			].join(' '),
			report: { kind: 'file', path: options.reportFile },
			format: 'junit-node',
			...(coverageFile ? { coverageFile } : {}),
		};
	},
	missing: (output, exitCode, options) => /bad option: --test-reporter|bad option: --test\b/.test(output) ? { what: 'Node.js 20 or newer (node --test with reporters)', install: options.windows ? 'winget install OpenJS.NodeJS' : 'brew install node' } : missingJs('node')(output, exitCode, options),
	debug: (selection, options) => nodeTerminalDebug(nodeTestAdapter)(selection, options),
};

export const bunTestAdapter: ITestAdapter = {
	...jsBase,
	id: 'bun',
	label: 'bun test',
	markers: [...PACKAGE_MARKERS, 'bunfig.toml'],
	detect: folder => isBun(folder) ? { data: jsData(folder) } : undefined,
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const { files, named, allNamed } = splitSelection(selection);
		const coverageFile = options.coverage ? `${options.reportFile}.coverage` : undefined;
		return {
			command: [
				'bun', 'test', '--reporter=junit', `--reporter-outfile=${q(options.reportFile)}`,
				...(coverageFile ? ['--coverage', '--coverage-reporter=lcov', `--coverage-dir=${q(coverageFile)}`] : []),
				...(allNamed ? ['-t', q(jsNamePattern(named))] : []),
				// A bare name is a filter for bun; a path starts with ./
				...files.map(file => q(/^(?:\.{0,2}\/|[A-Za-z]:)/.test(file) ? file : `./${file}`)),
			].join(' '),
			report: { kind: 'file', path: options.reportFile },
			format: 'junit-node',
			...(coverageFile ? { coverageFile: `${coverageFile}/lcov.info` } : {}),
		};
	},
	// bun prints a failure above its "(fail) suite > test [1ms]" line: the lines since the last result or file header.
	failureDetails(output) {
		const out: { path: string[]; message: string }[] = [];
		let block: string[] = [];
		for (const line of output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n')) {
			const result = /^\((pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+ ?m?s\])?$/.exec(line);
			if (result) {
				if (result[1] === 'fail' && block.join('').trim()) {
					out.push({ path: result[2].split(' > '), message: block.join('\n').trim() });
				}
				block = [];
			} else if (/^\S+\.[cm]?[jt]sx?:$/.test(line)) {
				block = [];
			} else {
				block.push(line);
			}
		}
		return out;
	},
	missing: (output, exitCode, options) => /command not found: bun|bun: (?:command )?not found|'bun' is not recognized/.test(output) ? { what: 'bun', install: options.windows ? 'powershell -c "irm bun.sh/install.ps1 | iex"' : 'curl -fsSL https://bun.sh/install | bash' } : undefined,
};
