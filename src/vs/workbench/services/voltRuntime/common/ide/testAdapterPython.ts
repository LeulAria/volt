/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fillTestEnds, IMissingTool, IOpenTest, IRuntimeCandidate, IStaticTest, ITestAdapter, ITestCommandOptions, missingToolchain, shellQuote, splitSelection } from './testAdapter.js';

const PYTHON_MARKERS = ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'setup.py', 'conftest.py', 'requirements.txt', 'Pipfile', 'uv.lock', 'poetry.lock'] as const;

/**
 * Test classes and test functions of a Python test file, nested by indentation: `Test*` classes
 * and `unittest.TestCase` subclasses, `test*` functions and methods. What pytest and unittest
 * both collect.
 */
export function parsePythonTests(text: string): IStaticTest[] {
	const roots: IStaticTest[] = [];
	// Every class and function opens a scope; only collected classes hold tests. Methods of other
	// classes and functions nested in functions are not collected (pytest skips `class Helper:`).
	const stack: { node: IOpenTest | undefined; indent: number }[] = [];
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
		const cls = /^(\s*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/.exec(line);
		const fn = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(line);
		const scope = stack.at(-1);
		const parent = scope?.node;
		const collects = !scope || parent?.kind === 'suite';
		if (cls && collects && (/^Test/.test(cls[2]) || /\bTestCase\b/.test(cls[3] ?? ''))) {
			const node: IOpenTest = { name: cls[2], kind: 'suite', line: index + 1, endLine: index + 1, children: [], ...(/\bTestCase\b/.test(cls[3] ?? '') ? { flavor: 'unittest' } : {}) };
			(parent?.children ?? roots).push(node);
			stack.push({ node, indent });
		} else if (cls || /^\s*(?:async\s+)?def\s/.test(line)) {
			if (fn && collects) {
				(parent?.children ?? roots).push({ name: fn[2], kind: 'test', line: index + 1, endLine: index + 1, children: [] });
			}
			stack.push({ node: undefined, indent });
		}
		for (const open of stack) {
			if (open.node) {
				open.node.endLine = index + 1;
			}
		}
	}
	fillTestEnds(roots, lines.length);
	return roots;
}

/** Whether unittest alone can run everything a file declares: only TestCase classes, no module-level test functions. */
export function isUnittestOnly(tests: readonly IStaticTest[]): boolean {
	return tests.length > 0 && tests.every(test => test.kind === 'suite' && test.flavor === 'unittest');
}

/** The interpreter: the project's virtualenv, else its package manager's, else the platform's. */
export function pythonRuntimes(windows: boolean): readonly IRuntimeCandidate[] {
	const venv = (name: string) => windows ? `${name}/Scripts/python.exe` : `${name}/bin/python`;
	return [
		{ exists: [venv('.venv')], argv: ['{}'] },
		{ exists: [venv('venv')], argv: ['{}'] },
		{ exists: ['uv.lock'], argv: ['uv', 'run', 'python'] },
		{ exists: ['poetry.lock'], argv: ['poetry', 'run', 'python'] },
		{ exists: ['Pipfile'], argv: ['pipenv', 'run', 'python'] },
		{ argv: [windows ? 'python' : 'python3'] },
	];
}

function interpreter(options: ITestCommandOptions): string[] {
	return options.runtime ? [...options.runtime] : [options.python ?? (options.windows ? 'python' : 'python3')];
}

/** How a package is added for the interpreter in use. */
function pipInstall(options: ITestCommandOptions, pkg: string): string {
	const argv = interpreter(options);
	switch (argv[0]) {
		case 'uv': return `uv add --dev ${pkg}`;
		case 'poetry': return `poetry add --group dev ${pkg}`;
		case 'pipenv': return `pipenv install --dev ${pkg}`;
	}
	return `${argv.map(part => shellQuote(part, options.windows)).join(' ')} -m pip install ${pkg}`;
}

function missingPython(output: string, exitCode: number | null, options: ITestCommandOptions): IMissingTool | undefined {
	const forWhom = interpreter(options).join(' ');
	const module = /No module named ['"]?(pytest|pytest_cov|coverage|unittest)\b/.exec(output);
	if (module && exitCode !== 0) {
		const pkg = module[1] === 'pytest_cov' ? 'pytest-cov' : module[1];
		return { what: pkg, for: forWhom, install: pipInstall(options, pkg) };
	}
	if (/unrecognized arguments: .*--cov/.test(output)) {
		return { what: 'pytest-cov (coverage for pytest)', for: forWhom, install: pipInstall(options, 'pytest-cov') };
	}
	return missingToolchain(output, exitCode, options.windows, { python3: 'Python (python3)', python: 'Python', uv: 'uv', poetry: 'Poetry', pipenv: 'Pipenv' });
}

function isPytestProject(files: ReadonlyMap<string, string>): boolean {
	return files.has('pytest.ini') || files.has('conftest.py') || files.has('tox.ini') || files.has('setup.py') || files.has('pyproject.toml') || files.has('setup.cfg') || files.has('requirements.txt') || files.has('Pipfile');
}

function modulePath(file: string): string {
	return file.replace(/\\/g, '/').replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.');
}

export const pytestAdapter: ITestAdapter = {
	id: 'pytest',
	label: 'pytest',
	family: 'python',
	globs: ['**/{test_*.py,*_test.py}'],
	markers: PYTHON_MARKERS,
	isTestFile: relative => /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/.test(relative),
	detect: folder => isPytestProject(folder.files) ? {} : undefined,
	// pytest runs from the scanned folder when there is no config file at all.
	fallback: true,
	parse: text => parsePythonTests(text),
	variants: 'suffix',
	runtimes: pythonRuntimes,
	coverage: true,
	probe(options) {
		const argv = interpreter(options).map(part => shellQuote(part, options.windows));
		return { command: [...argv, '-c', shellQuote('import pytest', options.windows)].join(' '), missing: { what: 'pytest', for: interpreter(options).join(' '), install: pipInstall(options, 'pytest') }, fallback: 'unittest' };
	},
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const ids = selection.map(item => [item.file, ...item.path].join('::'));
		const coverageFile = options.coverage ? `${options.reportFile}.lcov` : undefined;
		return {
			// -v names each test as it finishes (live results); -rN drops the summary the report already has.
			command: [...interpreter(options).map(q), '-m', 'pytest', '-v', '-rN', '--no-header', `--junitxml=${q(options.reportFile)}`, '-o', 'junit_family=xunit1', ...(coverageFile ? ['--cov', `--cov-report=lcov:${q(coverageFile)}`] : []), ...ids.map(q)].join(' '),
			report: { kind: 'file', path: options.reportFile },
			format: 'junit-pytest',
			stream: 'pytest-verbose',
			...(coverageFile ? { coverageFile } : {}),
		};
	},
	missing: missingPython,
	debug(selection, options) {
		const command = pytestAdapter.command(selection, { ...options, coverage: false });
		const argv = interpreter(options);
		return {
			type: 'debugpy',
			extension: 'the Python Debugger extension (ms-python.debugpy)',
			config: {
				type: 'debugpy', request: 'launch', module: 'pytest', cwd: options.cwd, justMyCode: true, console: 'internalConsole',
				args: ['-v', '-rN', '--no-header', `--junitxml=${options.reportFile}`, '-o', 'junit_family=xunit1', ...selection.map(item => [item.file, ...item.path].join('::'))],
				// A virtualenv's interpreter is a path; `uv run python` and the like leave the choice to the extension.
				...(argv.length === 1 && /[\\/]/.test(argv[0]) ? { python: argv[0] } : {}),
			},
			report: command.report,
			format: command.format,
		};
	},
	affects: (changed, testFile) => {
		const stem = (path: string) => (path.split('/').pop() ?? '').replace(/\.py$/, '').replace(/^test_|_test$/g, '');
		return changed.endsWith('.py') && stem(changed) === stem(testFile);
	},
};

export const unittestAdapter: ITestAdapter = {
	id: 'unittest',
	label: 'unittest',
	family: 'python',
	globs: pytestAdapter.globs,
	markers: PYTHON_MARKERS,
	isTestFile: pytestAdapter.isTestFile,
	// Chosen by the controller when pytest is not installed, never by a folder's files.
	detect: () => undefined,
	parse: text => parsePythonTests(text),
	runtimes: pythonRuntimes,
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const { allNamed } = splitSelection(selection);
		const targets = selection.map(item => allNamed || item.path.length ? [modulePath(item.file), ...item.path].join('.') : item.file);
		return {
			// unittest writes its results to stderr, the same lines the report is read from.
			command: [...interpreter(options).map(q), '-m', 'unittest', ...(targets.length ? ['-v', ...targets.map(q)] : ['discover', '-v'])].join(' '),
			report: { kind: 'stdout' },
			format: 'unittest-text',
			stream: 'unittest-text',
		};
	},
	missing: missingPython,
	debug(selection, options) {
		const argv = interpreter(options);
		return {
			type: 'debugpy',
			extension: 'the Python Debugger extension (ms-python.debugpy)',
			config: {
				type: 'debugpy', request: 'launch', module: 'unittest', cwd: options.cwd, justMyCode: true, console: 'internalConsole',
				args: ['-v', ...selection.map(item => item.path.length ? [modulePath(item.file), ...item.path].join('.') : item.file)],
				...(argv.length === 1 && /[\\/]/.test(argv[0]) ? { python: argv[0] } : {}),
			},
		};
	},
	affects: pytestAdapter.affects,
};
