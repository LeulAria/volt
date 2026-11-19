/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { braceDelta, escapeRegExp, IMissingTool, IOpenTest, IStaticTest, ITestAdapter, ITestCommand, ITestCommandOptions, ITestSelection, missingToolchain, shellQuote, splitSelection } from './testAdapter.js';

export type CppTestFlavor = 'gtest' | 'catch2' | 'doctest';

/** Which C++ test library a file uses, from its includes, else from the macros only one of them has. */
export function cppTestFlavor(text: string): CppTestFlavor | undefined {
	if (/#\s*include\s*[<"](?:gtest|gmock)\//.test(text)) {
		return 'gtest';
	}
	if (/#\s*include\s*[<"][^>"]*doctest[^>"]*[>"]/.test(text)) {
		return 'doctest';
	}
	if (/#\s*include\s*[<"][^>"]*catch[^>"]*[>"]/i.test(text)) {
		return 'catch2';
	}
	if (/^\s*(?:TEST|TEST_F|TEST_P|TYPED_TEST|TYPED_TEST_P)\s*\(\s*\w+\s*,\s*\w+\s*\)/m.test(text)) {
		return 'gtest';
	}
	if (/\bSUBCASE\s*\(|\bTEST_SUITE\s*\(/.test(text)) {
		return 'doctest';
	}
	return /\b(?:TEST_CASE|SCENARIO)\s*\(/.test(text) ? 'catch2' : undefined;
}

const GTEST_DECL = /^\s*(TEST|TEST_F|TEST_P|TYPED_TEST|TYPED_TEST_P)\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/;
const CASE_DECL = /^\s*(TEST_CASE|TEST_CASE_METHOD|TEST_CASE_FIXTURE|TEST_CASE_TEMPLATE|TEMPLATE_TEST_CASE|SCENARIO|TEST_SUITE)\s*\(\s*(?:[\w:<>]+\s*,\s*)?"((?:\\.|[^"\\])*)"/;
const PART_DECL = /^\s*(SECTION|SUBCASE|GIVEN|WHEN|THEN|AND_WHEN|AND_THEN|AND_GIVEN)\s*\(\s*"((?:\\.|[^"\\])*)"/;
const PART_PREFIX: Readonly<Record<string, string>> = { GIVEN: 'Given: ', WHEN: 'When: ', THEN: 'Then: ', AND_WHEN: 'And when: ', AND_THEN: 'And then: ', AND_GIVEN: 'And given: ' };

/**
 * The tests of a C++ file: GoogleTest `TEST`/`TEST_F`/`TEST_P` grouped by suite; Catch2 and
 * doctest `TEST_CASE`/`SCENARIO` with their `SECTION`/`SUBCASE` parts under them.
 */
export function parseCppTests(text: string): IStaticTest[] {
	const flavor = cppTestFlavor(text);
	if (!flavor) {
		return [];
	}
	const lines = text.split('\n');
	const roots: IStaticTest[] = [];
	if (flavor === 'gtest') {
		const suites = new Map<string, IOpenTest>();
		for (let index = 0; index < lines.length; index++) {
			const match = GTEST_DECL.exec(lines[index]);
			if (!match) {
				continue;
			}
			let suite = suites.get(match[2]);
			if (!suite) {
				suite = { name: match[2], kind: 'suite', line: index + 1, endLine: index + 1, children: [], flavor };
				suites.set(match[2], suite);
				roots.push(suite);
			}
			suite.children.push({ name: match[3], kind: 'test', line: index + 1, endLine: index + 1, children: [], flavor });
			suite.endLine = lines.length;
		}
		// A suite's tests need not be together: each test ends at the next TEST of the file.
		const all = roots.flatMap(suite => suite.children).sort((a, b) => a.line - b.line);
		all.forEach((test, index) => (test as IOpenTest).endLine = Math.max(test.line, (all[index + 1]?.line ?? lines.length + 1) - 1));
		for (const suite of roots) {
			(suite as IOpenTest).endLine = Math.max(...suite.children.map(test => test.endLine));
		}
		return roots;
	}
	const stack: { readonly node: IOpenTest; readonly depth: number }[] = [];
	let depth = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const testCase = CASE_DECL.exec(line);
		const part = testCase ? null : PART_DECL.exec(line);
		if (testCase) {
			const suite = testCase[1] === 'TEST_SUITE';
			const node: IOpenTest = { name: `${testCase[1] === 'SCENARIO' ? 'Scenario: ' : ''}${unescapeC(testCase[2])}`, kind: suite ? 'suite' : 'test', line: index + 1, endLine: index + 1, children: [], flavor };
			const parent = stack.findLast(open => open.node.kind === 'suite');
			(parent?.node.children ?? roots).push(node);
			stack.push({ node, depth });
		} else if (part && stack.length) {
			const node: IOpenTest = { name: `${PART_PREFIX[part[1]] ?? ''}${unescapeC(part[2])}`, kind: 'test', line: index + 1, endLine: index + 1, children: [], flavor };
			stack[stack.length - 1].node.children.push(node);
			stack.push({ node, depth });
		}
		depth += braceDelta(line, false, true);
		while (stack.length && depth <= stack[stack.length - 1].depth && (index + 1 > stack[stack.length - 1].node.line || /\}\s*$/.test(line))) {
			stack.pop()!.node.endLine = index + 1;
		}
	}
	for (const open of stack) {
		open.node.endLine = lines.length;
	}
	return roots.filter(node => node.kind === 'test' || node.children.length);
}

function unescapeC(text: string): string {
	return text.replace(/\\(.)/g, '$1');
}

/** What a CMakeLists.txt says about its tests. */
export function cmakeInfo(text: string): { readonly project: boolean; readonly ctest: boolean; readonly testBinaries: string[] } {
	const clean = text.replace(/#.*$/gm, '');
	const linked = new Set([...clean.matchAll(/target_link_libraries\s*\(\s*([\w.-]+)[^)]*?(?:gtest|gmock|GTest::|Catch2|doctest)/gi)].map(match => match[1]));
	return {
		project: /^\s*project\s*\(/im.test(clean),
		ctest: /\benable_testing\s*\(|\binclude\s*\(\s*CTest\s*\)|\badd_test\s*\(|_discover_tests\s*\(/i.test(clean),
		testBinaries: [...clean.matchAll(/add_executable\s*\(\s*([\w.-]+)/gi)].map(match => match[1]).filter(name => linked.has(name)),
	};
}

/** The build folder: the one cmake already configured, else `build`. */
function buildDir(options: ITestCommandOptions): { readonly dir: string; readonly configured: boolean } {
	const cache = options.runtime?.[0];
	return cache && /CMakeCache\.txt$/.test(cache) ? { dir: cache.replace(/[\\/]CMakeCache\.txt$/, ''), configured: true } : { dir: 'build', configured: false };
}

/** The ctest name pattern for a selection: `Suite.Test` for GoogleTest (also inside `Instance/Suite.Test/0`), the case name for Catch2 and doctest. */
export function ctestPattern(named: readonly ITestSelection[]): string {
	const one = (item: ITestSelection) => {
		if ((item.flavor ?? 'gtest') === 'gtest') {
			return item.kind === 'suite' || item.path.length === 1 ? `(?:^|/)${escapeRegExp(item.path[0])}\\.` : `(?:^|/)${escapeRegExp(item.path[0])}\\.${escapeRegExp(item.path[1])}(?:/|$)`;
		}
		// A section or subcase runs with its test case: the case is the first name that is not a doctest suite.
		return `^${escapeRegExp(item.path[item.kind === 'suite' ? 0 : Math.min(item.path.length - 1, item.suiteDepth ?? 0)])}${item.kind === 'suite' ? '' : '$'}`;
	};
	return [...new Set(named.map(one))].join('|');
}

/** The arguments that make a test binary run a selection and write a report Volt reads. */
function binaryArgs(flavor: CppTestFlavor, named: readonly ITestSelection[], all: boolean, reportFile: string, q: (value: string) => string): string[] {
	switch (flavor) {
		case 'gtest': {
			const filter = all ? [] : [q(`--gtest_filter=${[...new Set(named.map(item => item.kind === 'suite' || item.path.length === 1 ? `${item.path[0]}.*:*/${item.path[0]}.*` : `${item.path[0]}.${item.path[1]}:*/${item.path[0]}.${item.path[1]}/*`))].join(':')}`)];
			return [q(`--gtest_output=xml:${reportFile}`), ...filter];
		}
		case 'catch2':
			return ['-r', 'junit', '-o', q(reportFile), ...(all ? [] : [...new Set(named.map(item => q(item.path[0].replace(/([,[\]*\\])/g, '\\$1'))))])];
		case 'doctest':
			return ['--reporters=junit', q(`--out=${reportFile}`), ...(all ? [] : [q(`--test-case=${[...new Set(named.map(item => item.path[item.suiteDepth ?? 0].replace(/,/g, '\\,')))].join(',')}`)])];
	}
}

function missingCpp(output: string, exitCode: number | null, options: ITestCommandOptions): IMissingTool | undefined {
	const tool = missingToolchain(output, exitCode, options.windows, { cmake: 'CMake (cmake and ctest)', ctest: 'CMake (cmake and ctest)' });
	if (tool) {
		return tool;
	}
	if (/No CMAKE_CXX_COMPILER could be found|CMAKE_CXX_COMPILER not set|is not able to compile a simple test program/.test(output)) {
		return { what: 'a C++ compiler', install: options.windows ? 'winget install Microsoft.VisualStudio.2022.BuildTools' : 'xcode-select --install' };
	}
	if (/Unknown argument:?\s*--output-junit|unrecognized option .*--output-junit/.test(output)) {
		return { what: 'CMake 3.21 or newer (ctest --output-junit)', install: options.windows ? 'winget install Kitware.CMake' : 'brew install cmake' };
	}
	return undefined;
}

export const ctestAdapter: ITestAdapter = {
	id: 'ctest',
	label: 'CTest',
	family: 'cpp',
	globs: ['**/*.{cpp,cc,cxx,c++,cppm,ixx}'],
	contentPattern: '^\\s*(?:TEST|TEST_F|TEST_P|TYPED_TEST|TYPED_TEST_P|TEST_CASE|TEST_CASE_METHOD|TEST_CASE_FIXTURE|TEMPLATE_TEST_CASE|SCENARIO)\\s*\\(',
	markers: ['CMakeLists.txt'],
	isTestFile: relative => /\.(?:cpp|cc|cxx|c\+\+|cppm|ixx)$/.test(relative),
	// A subdirectory's CMakeLists.txt (no project()) belongs to the project above it.
	detect(folder) {
		const text = folder.files.get('CMakeLists.txt');
		if (text === undefined) {
			return undefined;
		}
		const info = cmakeInfo(text);
		if (!info.project) {
			return undefined;
		}
		return { data: { ctest: info.ctest ? 'yes' : '', binaries: info.testBinaries.join(',') } };
	},
	parse: text => parseCppTests(text),
	selectsFiles: false,
	runtimes: () => [
		{ exists: ['build/CMakeCache.txt'], argv: ['{}'] },
		{ exists: ['cmake-build-debug/CMakeCache.txt'], argv: ['{}'] },
		{ exists: ['out/build/CMakeCache.txt'], argv: ['{}'] },
		{ exists: ['_build/CMakeCache.txt'], argv: ['{}'] },
		{ argv: ['build'] },
	],
	command(selection, options): ITestCommand {
		const q = (value: string) => shellQuote(value, options.windows);
		const { named, allNamed } = splitSelection(selection);
		const { dir, configured } = buildDir(options);
		const build = [...(configured ? [] : [`cmake -S . -B ${q(dir)}`]), `cmake --build ${q(dir)}`];
		const binaries = (options.data?.binaries ?? '').split(',').filter(Boolean);
		if (!options.data?.ctest && binaries.length === 1) {
			// No CTest registration: the one test binary runs directly and writes its own report.
			const flavor = (selection.find(item => item.flavor)?.flavor ?? 'gtest') as CppTestFlavor;
			const binary = `${dir.replace(/[\\/]$/, '')}/${binaries[0]}${options.windows ? '.exe' : ''}`;
			return {
				command: [`${build.join(' && ')} --target ${q(binaries[0])}`, [q(binary), ...binaryArgs(flavor, named, !allNamed, options.reportFile, q)].join(' ')].join(' && '),
				report: { kind: 'file', path: options.reportFile },
				format: flavor === 'gtest' ? 'junit-gtest' : 'junit-ctest',
			};
		}
		return {
			command: [...build, ['ctest', '--test-dir', q(dir), '--output-junit', q(options.reportFile), '--output-on-failure', ...(allNamed ? ['-R', q(ctestPattern(named))] : [])].join(' ')].join(' && '),
			report: { kind: 'file', path: options.reportFile },
			format: 'junit-ctest',
		};
	},
	missing: missingCpp,
	debug: () => 'Debugging C++ tests needs a native debugger extension (C/C++ or CodeLLDB) pointed at the test binary; Volt\'s runner does not start one. Run the test here, or debug the binary from Run and Debug.',
	affects: (changed, testFile) => {
		const stem = (path: string) => (path.split('/').pop() ?? '').replace(/\.\w+$/, '').replace(/^test_|_tests?$|Tests?$/g, '');
		return /\.(?:c|cc|cpp|cxx|h|hpp|hh|hxx)$/.test(changed) && stem(changed) === stem(testFile);
	},
};
