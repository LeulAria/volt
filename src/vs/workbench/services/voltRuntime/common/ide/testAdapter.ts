/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What one test framework needs from Volt's runner, as data and pure functions: which files can
 * hold its tests, how a folder shows it is one of its projects, the tests a file declares (read
 * statically, so discovery never runs project code), the command that runs a selection with a
 * report Volt can read, and how it can be debugged. The table of adapters is in
 * `testFrameworks.ts`; the window's test controller does the I/O.
 */

export type TestFramework =
	| 'vitest' | 'jest' | 'mocha' | 'playwright' | 'node' | 'bun'
	| 'pytest' | 'unittest'
	| 'go' | 'cargo'
	| 'ctest' | 'dotnet' | 'maven' | 'gradle'
	| 'rspec' | 'minitest' | 'phpunit' | 'dart' | 'swift' | 'mix';

/** Adapters of one family compete for the same files; the nearest project that claims a file runs it. */
export type TestFamily = 'js' | 'python' | 'go' | 'rust' | 'cpp' | 'dotnet' | 'jvm' | 'ruby' | 'php' | 'dart' | 'swift' | 'elixir';

export interface IStaticTest {
	readonly name: string;
	/** A test with children has parts of its own (Catch2 sections, doctest subcases): the test is what runs. */
	readonly kind: 'suite' | 'test';
	/** 1-based lines. */
	readonly line: number;
	readonly endLine: number;
	readonly children: IStaticTest[];
	/** The namespace or package a top-level suite lives in (C#, Java, Kotlin): runners select by qualified name. */
	readonly scope?: string;
	/** The dialect inside a framework, when the command depends on it (gtest, catch2, doctest). */
	readonly flavor?: string;
}

/** One test selected to run: its file (relative to the project folder) and its name path in that file. */
export interface ITestSelection {
	readonly file: string;
	/** Suite names then the test name; empty for the whole file. */
	readonly path: readonly string[];
	/** What the path names: a suite runs everything under it. Default: a test. */
	readonly kind?: 'suite' | 'test';
	/** The namespace or package of the path's first suite. */
	readonly scope?: string;
	readonly flavor?: string;
	/** How many leading names of the path are suites. */
	readonly suiteDepth?: number;
}

export type TestReportFormat =
	| 'jest-json' | 'mocha-json' | 'go-json' | 'cargo-text' | 'unittest-text' | 'trx'
	| 'junit' | 'junit-pytest' | 'junit-jvm' | 'junit-ctest' | 'junit-gtest' | 'junit-node' | 'junit-playwright'
	| 'junit-rspec' | 'junit-phpunit' | 'junit-minitest' | 'dart-json' | 'swift-text' | 'junit-mix';

/** A runner's output that names tests as they finish, for live results. */
export type TestStreamFormat = 'go-json' | 'cargo-text' | 'pytest-verbose' | 'unittest-text' | 'vitest-verbose' | 'jest-verbose' | 'dotnet-console' | 'dart-json' | 'swift-text';

/** Where a run's report is. */
export type TestReportSource =
	/** A file the command writes; Volt deletes it once read. */
	| { readonly kind: 'file'; readonly path: string }
	/** A folder of Volt's the command writes report files into; deleted once read. */
	| { readonly kind: 'folder'; readonly path: string; readonly extension: string }
	/** The command's own output is the report. */
	| { readonly kind: 'stdout' }
	/** Report files the build tool writes into the project's build output (globs relative to the project folder); the ones this run wrote are read and left where they are. */
	| { readonly kind: 'project'; readonly globs: readonly string[] };

export interface ITestCommand {
	/** A shell command line, run in the project folder. */
	readonly command: string;
	readonly report: TestReportSource;
	readonly format: TestReportFormat;
	readonly stream?: TestStreamFormat;
	/** A coverage report the command writes (absolute), deleted once read. */
	readonly coverageFile?: string;
}

export interface ITestCommandOptions {
	/** A path of Volt's own (a temp file; a folder for runners that write several) the report may go to. */
	readonly reportFile: string;
	readonly windows: boolean;
	readonly coverage?: boolean;
	/** What `detect` learned about the project. */
	readonly data?: Readonly<Record<string, string>>;
	/** The interpreter or tool the controller resolved from `runtimes` (argv, unquoted). */
	readonly runtime?: readonly string[];
	/** @deprecated the pytest interpreter; `runtime` replaces it. */
	readonly python?: string;
}

/** The marker files of one folder: name to text ('' when a file was too large to read). */
export interface IFolderProbe {
	readonly files: ReadonlyMap<string, string>;
}

export interface IDetectedProject {
	/** Which files under the project folder (relative paths) this framework runs; all of its family's when undefined. */
	readonly owns?: (relative: string) => boolean;
	/** What the command needs to know about the project (crate name, project file, build folder, test folder...). */
	readonly data?: Readonly<Record<string, string>>;
}

/**
 * One way to start the framework's tool, tried in order: the first whose `exists` path is found in
 * the project folder or a folder above it (up to the folder Volt scanned) wins. `{}` in `argv` is
 * that path, absolute.
 */
export interface IRuntimeCandidate {
	readonly exists?: readonly string[];
	readonly argv: readonly string[];
}

/** Something a run needs that is not there. */
export interface IMissingTool {
	/** "pytest", "node_modules (vitest)", "the .NET SDK (dotnet)". */
	readonly what: string;
	/** The interpreter it is missing from, when that matters (a virtualenv's Python). */
	readonly for?: string;
	/** The command that installs it, when one command does. */
	readonly install?: string;
}

/** A check that the framework's runner can start, run before the tests (cheap: it exits at once). */
export interface IRunnerProbe {
	/** Exits 0 when the runner is there. */
	readonly command: string;
	readonly missing: IMissingTool;
	/** The framework to run the same files with when it is not (pytest without pytest: unittest), if they are its tests too. */
	readonly fallback?: TestFramework;
}

/** A debug configuration for a selection, or why there is none. */
export interface ITestDebugPlan {
	/** The debug adapter type that must be in the window ('node-terminal', 'debugpy', 'go', ...). */
	readonly type: string;
	/** The extension that brings it, for the message when it is not there. */
	readonly extension: string;
	readonly config: Readonly<Record<string, unknown>>;
	/** The report the debugged run writes, read when the session ends. */
	readonly report?: TestReportSource;
	readonly format?: TestReportFormat;
}

export interface ITestAdapter {
	readonly id: TestFramework;
	readonly label: string;
	readonly family: TestFamily;
	/** Globs (relative, `**` style) of the files that can hold its tests. */
	readonly globs: readonly string[];
	/** A file is only a test file when its text matches this (Rust, C++, C#: any source file may hold tests). Searched for, never read by the window, during discovery. */
	readonly contentPattern?: string;
	/** Marker file names (or `*.ext`) looked for in each folder from a test file up to the scanned folder. */
	readonly markers: readonly string[];
	/** Whether a path (relative to the scanned folder, `/` separated) can be one of its test files, by name alone. */
	isTestFile(relative: string): boolean;
	/** The project this folder is, from its marker files; undefined when it is not one of this framework's. */
	detect(folder: IFolderProbe): IDetectedProject | undefined;
	/** Claims files of its family that no project folder claimed, with the scanned folder as the project (pytest without any config file). */
	readonly fallback?: boolean;
	/** The tests a file declares. */
	parse(text: string, relative: string): IStaticTest[];
	/** False when the runner cannot run a file by its path: the controller selects the file's tests by name instead. */
	readonly selectsFiles?: boolean;
	/** How one generated case of a test (a subtest, a parameter set) is selected: as one more name in the path (go's `Test/sub`), or appended to the test's name (pytest's `test[1-2]`). Without it the whole test runs. */
	readonly variants?: 'subpath' | 'suffix';
	/** Names the runner prefixes to a file's tests (cargo: the module path). */
	prefix?(relative: string): string[];
	runtimes?(windows: boolean): readonly IRuntimeCandidate[];
	probe?(options: ITestCommandOptions): IRunnerProbe | undefined;
	/** The command that runs `selection` (empty: the whole project). */
	command(selection: readonly ITestSelection[], options: ITestCommandOptions): ITestCommand;
	/** What a failed start is missing, from the command's output and exit code. */
	missing?(output: string, exitCode: number | null, options: ITestCommandOptions): IMissingTool | undefined;
	/** How to debug a selection; a string says why it cannot be. */
	debug?(selection: readonly ITestSelection[], options: ITestCommandOptions & { readonly cwd: string }): ITestDebugPlan | string;
	/** Failure text the report leaves out and the output has (bun's JUnit says only "AssertionError"), by the test's names. */
	failureDetails?(output: string): { readonly path: readonly string[]; readonly message: string }[];
	/** Whether the Coverage profile produces coverage Volt can read. */
	readonly coverage?: boolean;
	/** Source files a changed file can affect, for run on save: true when `changed` (relative) belongs to what `testFile` tests. Default: the same folder or the test file itself. */
	affects?(changed: string, testFile: string): boolean;
}

// --- Helpers adapters share ------------------------------------------------------------------

/** Quotes one shell argument for the platform shell (POSIX sh or cmd.exe). */
export function shellQuote(value: string, windows: boolean): string {
	// cmd.exe takes a backslash as it is; a POSIX shell would eat it.
	if ((windows ? /^[\w./:=@%+\\-]+$/ : /^[\w./:=@%+-]+$/).test(value)) {
		return value;
	}
	return windows ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Brace and parenthesis depth change of a line, ignoring those inside strings and line comments.
 * `charLiterals`: a single quote starts a character, not a string (Rust, C, C++, C#, Java), so a
 * Rust lifetime or a C++ digit separator swallows nothing.
 */
export function braceDelta(line: string, parens = true, charLiterals = false): number {
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
		if (ch === '\'' && charLiterals) {
			const literal = /^'(?:\\.[^']*|[^'\\])'/.exec(line.slice(i));
			i += literal ? literal[0].length - 1 : 0;
			continue;
		}
		if (ch === '"' || ch === '\'' || ch === '`') {
			quote = ch;
		} else if (ch === '{' || (parens && ch === '(')) {
			delta++;
		} else if (ch === '}' || (parens && ch === ')')) {
			delta--;
		}
	}
	return delta;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type IOpenTest = Mutable<IStaticTest>;

/** A test ends where its next sibling starts (or its suite ends). Good enough for ranges and file:line. */
export function fillTestEnds(nodes: IStaticTest[], end: number): void {
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i] as IOpenTest;
		if (node.kind === 'test') {
			node.endLine = Math.max(node.line, (nodes[i + 1]?.line ?? end + 1) - 1);
			if (node.children.length) {
				fillTestEnds(node.children, node.endLine);
			}
		} else {
			fillTestEnds(node.children, node.endLine);
		}
	}
}

/** Suites without a test under them go. */
export function pruneEmptySuites(nodes: IStaticTest[]): IStaticTest[] {
	return nodes.filter(node => node.kind === 'test' || (node.children.splice(0, node.children.length, ...pruneEmptySuites(node.children)), node.children.length > 0));
}

/** The files and named tests of a selection. `allNamed`: every entry names a test or suite (none is a whole file). */
export function splitSelection(selection: readonly ITestSelection[]): { readonly files: string[]; readonly named: ITestSelection[]; readonly allNamed: boolean } {
	const named = selection.filter(item => item.path.length);
	return { files: [...new Set(selection.map(item => item.file))], named, allNamed: named.length > 0 && named.length === selection.length };
}

export function parseJson<T>(text: string | undefined): T | undefined {
	if (!text) {
		return undefined;
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/** The first word of a command that the shell could not find, from its output and exit code. */
export function commandNotFound(output: string, exitCode: number | null): string | undefined {
	if (exitCode !== 127 && exitCode !== 9009 && exitCode !== 1 && exitCode !== null) {
		return undefined;
	}
	// zsh: "command not found: x"; sh, bash, dash: "sh: 1: x: not found", "/bin/sh: x: command not found"; cmd.exe: "'x' is not recognized ...".
	const match = /command not found: (\S+)/.exec(output)
		?? /(?:^|\n)(?:(?:\/\S+\/)?(?:ba|z|da|k)?sh: (?:line )?(?:\d+: )?)?([^\s:]+): (?:command )?not found/.exec(output)
		?? /'([^']+)' is not recognized as an internal or external command/.exec(output);
	return match?.[1];
}

/** One line a person can act on: what is missing, for which project, and the command that installs it. */
export function describeMissing(missing: IMissingTool, project: string): string {
	return `The tests did not start: ${missing.what} is not installed${missing.for ? ` for ${missing.for}` : ''}${project ? ` (project ${project})` : ''}.${missing.install ? ` Install it with: ${missing.install}` : ''}`;
}

/** How a toolchain is installed on this platform, for the messages of runs that could not start. */
export function toolInstallHint(tool: string, windows: boolean): string | undefined {
	const hints: Record<string, readonly [string, string]> = {
		go: ['brew install go (or https://go.dev/dl)', 'winget install GoLang.Go'],
		cargo: ['curl https://sh.rustup.rs -sSf | sh', 'winget install Rustlang.Rustup'],
		dotnet: ['brew install dotnet (or https://dot.net/download)', 'winget install Microsoft.DotNet.SDK.9'],
		mvn: ['brew install maven', 'winget install Apache.Maven'],
		gradle: ['brew install gradle', 'winget install Gradle.Gradle'],
		cmake: ['brew install cmake', 'winget install Kitware.CMake'],
		ctest: ['brew install cmake', 'winget install Kitware.CMake'],
		node: ['brew install node (or https://nodejs.org)', 'winget install OpenJS.NodeJS'],
		npx: ['brew install node (or https://nodejs.org)', 'winget install OpenJS.NodeJS'],
		bun: ['curl -fsSL https://bun.sh/install | bash', 'powershell -c "irm bun.sh/install.ps1 | iex"'],
		python3: ['brew install python', 'winget install Python.Python.3.13'],
		python: ['brew install python', 'winget install Python.Python.3.13'],
		uv: ['curl -LsSf https://astral.sh/uv/install.sh | sh', 'winget install astral-sh.uv'],
		poetry: ['pipx install poetry', 'pipx install poetry'],
		pipenv: ['pipx install pipenv', 'pipx install pipenv'],
		ruby: ['brew install ruby', 'winget install RubyInstallerTeam.Ruby.3.3'],
		bundle: ['gem install bundler', 'gem install bundler'],
		php: ['brew install php', 'winget install PHP.PHP'],
		dart: ['brew install dart-sdk (or https://dart.dev/get-dart)', 'winget install Google.DartSDK'],
		flutter: ['https://docs.flutter.dev/get-started/install', 'https://docs.flutter.dev/get-started/install'],
		swift: ['xcode-select --install (or https://swift.org/install)', 'winget install Swift.Toolchain'],
		mix: ['brew install elixir', 'winget install ElixirLang.Elixir'],
		java: ['brew install openjdk', 'winget install EclipseAdoptium.Temurin.21.JDK'],
	};
	return hints[tool]?.[windows ? 1 : 0];
}

/** A missing toolchain command as an `IMissingTool`, when the shell said it could not find one of `tools`. */
export function missingToolchain(output: string, exitCode: number | null, windows: boolean, tools: Readonly<Record<string, string>>): IMissingTool | undefined {
	const command = commandNotFound(output, exitCode);
	const name = command?.split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, '');
	if (!name || !(name in tools)) {
		return undefined;
	}
	const install = toolInstallHint(name, windows);
	return { what: tools[name], ...(install ? { install } : {}) };
}

/** Whether `relative` is inside one of the folders tools keep out of a project's own sources. */
export function inIgnoredFolder(relative: string): boolean {
	return /(?:^|\/)(?:node_modules|\.git|dist|out|build|target|\.venv|venv|__pycache__|\.next|coverage|vendor|bin|obj|\.gradle|\.dart_tool|_build|deps|\.build)\//.test(relative);
}
