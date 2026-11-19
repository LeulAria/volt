/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Volt's own test runner for projects without a test extension. Every framework is one adapter
 * (`testAdapter.ts`): which files hold its tests, how a folder shows it is its project, the tests
 * a file declares (read statically, so discovery never runs project code), the command that runs
 * a selection with a machine-readable report, and how it is debugged. This file is the table and
 * what the window's test controller asks of it. Pure; the controller does the I/O.
 *
 * A new language is one adapter in the table plus its tests.
 */

import { IDetectedProject, IFolderProbe, ITestAdapter, ITestCommand, ITestCommandOptions, ITestSelection, TestFamily, TestFramework } from './testAdapter.js';
import { ctestAdapter } from './testAdapterCpp.js';
import { dotnetAdapter } from './testAdapterDotnet.js';
import { cargoAdapter, goAdapter } from './testAdapterGoRust.js';
import { bunTestAdapter, jestAdapter, mochaAdapter, nodeTestAdapter, playwrightAdapter, vitestAdapter } from './testAdapterJs.js';
import { gradleAdapter, mavenAdapter } from './testAdapterJvm.js';
import { pytestAdapter, unittestAdapter } from './testAdapterPython.js';

export type { IStaticTest, ITestAdapter, ITestCommand, ITestSelection, TestFamily, TestFramework, TestReportFormat } from './testAdapter.js';
export { shellQuote } from './testAdapter.js';
export { detectJsFramework, isJsTestPath, parseJsTests } from './testAdapterJs.js';
export { parsePythonTests } from './testAdapterPython.js';
export { parseGoTests, parseRustTests, rustModulePath } from './testAdapterGoRust.js';

/**
 * Every framework Volt's runner covers. Within a family the order is the order of preference
 * when one folder is set up for several (Playwright's own files before the unit-test runner's;
 * Vitest before Jest before Mocha).
 */
export const TEST_ADAPTERS: readonly ITestAdapter[] = [
	playwrightAdapter, vitestAdapter, jestAdapter, mochaAdapter, nodeTestAdapter, bunTestAdapter,
	pytestAdapter, unittestAdapter,
	goAdapter,
	cargoAdapter,
	ctestAdapter,
	dotnetAdapter,
	mavenAdapter, gradleAdapter,
];

const BY_ID = new Map(TEST_ADAPTERS.map(adapter => [adapter.id, adapter]));

export function testAdapter(framework: TestFramework): ITestAdapter {
	const adapter = BY_ID.get(framework);
	if (!adapter) {
		throw new Error(`No test adapter for ${framework}.`);
	}
	return adapter;
}

export const TEST_FRAMEWORK_LABELS: Readonly<Record<string, string>> = Object.fromEntries(TEST_ADAPTERS.map(adapter => [adapter.id, adapter.label]));

/** The frameworks, for messages: "vitest, jest, ..., JUnit (Gradle)". */
export const TEST_FRAMEWORK_NAMES = TEST_ADAPTERS.map(adapter => adapter.label).join(', ');

export const TEST_EXCLUDE_GLOB = '**/{node_modules,.git,dist,out,build,target,.venv,venv,__pycache__,.next,coverage,vendor,bin,obj,.gradle,.dart_tool,_build,deps,.build,.tox,.mypy_cache,.pytest_cache}/**';

const FAMILIES: readonly TestFamily[] = [...new Set(TEST_ADAPTERS.map(adapter => adapter.family))];

export function adaptersOf(family: TestFamily): readonly ITestAdapter[] {
	return TEST_ADAPTERS.filter(adapter => adapter.family === family);
}

/** The family whose adapters may run a file, from its name alone (`relative`: `/` separated). */
export function familyOf(path: string): TestFamily | undefined {
	const relative = path.replace(/\\/g, '/');
	return FAMILIES.find(family => adaptersOf(family).some(adapter => adapter.isTestFile(relative)));
}

/**
 * What discovery searches for: test files found by name, and per family whose tests may sit in
 * any source file (Rust, C++, C#) the globs and the text a file must hold. Those are searched
 * only where a project of the family exists (its marker file was found).
 */
export function testFileSearches(): { readonly byName: readonly string[]; readonly byContent: readonly { readonly family: TestFamily; readonly globs: readonly string[]; readonly pattern: string }[] } {
	const byName = new Set<string>();
	const byContent = new Map<TestFamily, { family: TestFamily; globs: readonly string[]; pattern: string }>();
	for (const adapter of TEST_ADAPTERS) {
		if (adapter.contentPattern) {
			byContent.set(adapter.family, { family: adapter.family, globs: adapter.globs, pattern: adapter.contentPattern });
		} else {
			adapter.globs.forEach(glob => byName.add(glob));
		}
	}
	return { byName: [...byName], byContent: [...byContent.values()] };
}

/** Marker file names of every adapter: exact names, and extensions for `*.ext` markers. */
export function testMarkers(family?: TestFamily): { readonly names: ReadonlySet<string>; readonly extensions: readonly string[] } {
	const names = new Set<string>();
	const extensions = new Set<string>();
	for (const adapter of family ? adaptersOf(family) : TEST_ADAPTERS) {
		for (const marker of adapter.markers) {
			if (marker.startsWith('*.')) {
				extensions.add(marker.slice(1));
			} else {
				names.add(marker);
			}
		}
	}
	return { names, extensions: [...extensions] };
}

/** Whether a file name is some adapter's marker (a change to one re-detects the projects). */
export function isTestMarker(name: string, family?: TestFamily): boolean {
	const markers = testMarkers(family);
	return markers.names.has(name) || markers.extensions.some(extension => name.endsWith(extension));
}

/** The family that owns a marker file, for knowing which content searches are worth running. */
export function markerFamilies(name: string): TestFamily[] {
	return FAMILIES.filter(family => isTestMarker(name, family));
}

export interface IDetectedTestProject extends IDetectedProject {
	readonly adapter: ITestAdapter;
}

/** The projects of a family one folder is set up as, in order of preference. */
export function detectTestProjects(family: TestFamily, folder: IFolderProbe): IDetectedTestProject[] {
	const out: IDetectedTestProject[] = [];
	for (const adapter of adaptersOf(family)) {
		const detected = adapter.detect(folder);
		if (detected) {
			out.push({ ...detected, adapter });
		}
	}
	return out;
}

/** The adapter that takes a family's files no project folder claimed, with the scanned folder as the project. */
export function fallbackAdapter(family: TestFamily): ITestAdapter | undefined {
	return adaptersOf(family).find(adapter => adapter.fallback);
}

/**
 * The project a test file belongs to: the nearest folder (from the file's up to the scanned one)
 * that is a project of the file's family and claims the file. `folders` are nearest first, each
 * with its path relative to the scanned folder ('' for the scanned folder itself).
 */
export function resolveTestProject(file: string, folders: readonly { readonly path: string; readonly projects: readonly IDetectedTestProject[] }[]): { readonly adapter: ITestAdapter; readonly root: string; readonly data?: Readonly<Record<string, string>> } | undefined {
	const family = familyOf(file);
	if (!family) {
		return undefined;
	}
	for (const folder of folders) {
		const relative = folder.path ? file.slice(folder.path.length + 1) : file;
		for (const project of folder.projects) {
			if (project.adapter.family === family && project.adapter.isTestFile(relative) && (!project.owns || project.owns(relative))) {
				return { adapter: project.adapter, root: folder.path, ...(project.data ? { data: project.data } : {}) };
			}
		}
	}
	const fallback = fallbackAdapter(family);
	return fallback?.isTestFile(file) ? { adapter: fallback, root: '' } : undefined;
}

/**
 * The command that runs `selection` (empty: the whole project) with a report Volt can read.
 * `runtime` is the interpreter or tool the controller resolved (a project venv's Python, `./mvnw`).
 */
export function buildTestCommand(framework: TestFramework, selection: readonly ITestSelection[], options: ITestCommandOptions): ITestCommand {
	return testAdapter(framework).command(selection, options);
}
