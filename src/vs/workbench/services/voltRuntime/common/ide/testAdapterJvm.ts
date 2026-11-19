/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { braceDelta, fillTestEnds, IFolderProbe, IMissingTool, IOpenTest, IRuntimeCandidate, IStaticTest, ITestAdapter, ITestCommandOptions, ITestSelection, missingToolchain, pruneEmptySuites, shellQuote, splitSelection } from './testAdapter.js';

const TEST_ANNOTATION = /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Property)\b(?!\w)/;
const JVM_MODIFIERS = '(?:(?:public|protected|private|static|final|abstract|open|internal|inner|sealed|data|strictfp)\\s+)*';
const JVM_ANNOTATIONS = '(?:@[\\w.]+(?:\\((?:[^()]|\\([^()]*\\))*\\))?\\s+)*';
const JVM_CLASS = new RegExp(`^\\s*${JVM_ANNOTATIONS}${JVM_MODIFIERS}class\\s+(\\w+)`);
const JAVA_METHOD = new RegExp(`^\\s*${JVM_ANNOTATIONS}(?:(?:public|protected|private|static|final|synchronized|abstract|default)\\s+)*(?:<[^>]+>\\s+)?[\\w<>\\[\\],.?]+\\s+(\\w+)\\s*\\(`);
const KOTLIN_METHOD = new RegExp(`^\\s*${JVM_ANNOTATIONS}(?:(?:public|protected|private|internal|open|override|suspend|inline|final)\\s+)*fun\\s+(?:<[^>]+>\\s+)?(?:\`([^\`]+)\`|(\\w+))\\s*\\(`);

/**
 * The tests of a Java or Kotlin file: classes (and `@Nested` ones) with the methods JUnit 4/5 and
 * TestNG mark `@Test`, `@ParameterizedTest`, `@RepeatedTest` or `@TestFactory`. A top-level
 * class carries its package.
 */
export function parseJvmTests(text: string): IStaticTest[] {
	const roots: IStaticTest[] = [];
	const classes: { readonly node: IOpenTest; readonly depth: number }[] = [];
	const scope = /^\s*package\s+([\w.]+)/m.exec(text)?.[1];
	let depth = 0;
	let pending = false;
	let inBlockComment = false;
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index++) {
		let line = lines[index];
		if (inBlockComment) {
			const end = line.indexOf('*/');
			if (end < 0) {
				continue;
			}
			line = line.slice(end + 2);
			inBlockComment = false;
		}
		line = line.replace(/\/\*.*?\*\//g, '');
		const open = line.indexOf('/*');
		if (open >= 0 && !/".*\/\*/.test(line)) {
			inBlockComment = true;
			line = line.slice(0, open);
		}
		if (/^\s*\/\//.test(line)) {
			continue;
		}
		if (TEST_ANNOTATION.test(line)) {
			pending = true;
		}
		const cls = JVM_CLASS.exec(line);
		if (cls) {
			const node: IOpenTest = { name: cls[1], kind: 'suite', line: index + 1, endLine: index + 1, children: [], ...(!classes.length && scope ? { scope } : {}) };
			(classes.at(-1)?.node.children ?? roots).push(node);
			classes.push({ node, depth });
			pending = false;
		} else if (pending && classes.length) {
			const kotlin = KOTLIN_METHOD.exec(line);
			const java = kotlin ? null : JAVA_METHOD.exec(line);
			const name = kotlin ? kotlin[1] ?? kotlin[2] : java?.[1];
			if (name && !/^(?:if|for|while|switch|catch|return|new|assert\w*)$/.test(name)) {
				classes[classes.length - 1].node.children.push({ name, kind: 'test', line: index + 1, endLine: index + 1, children: [] });
				pending = false;
			}
		}
		depth += braceDelta(line, false, true);
		while (classes.length && depth <= classes[classes.length - 1].depth && index + 1 > classes[classes.length - 1].node.line) {
			classes.pop()!.node.endLine = index + 1;
		}
	}
	for (const open of classes) {
		open.node.endLine = lines.length;
	}
	const pruned = pruneEmptySuites(roots);
	fillTestEnds(pruned, lines.length);
	return pruned;
}

function isJvmTestPath(relative: string): boolean {
	return /\.(?:java|kt)$/.test(relative) && (/(?:^|\/)src\/(?:test|integrationTest|androidTest)\//.test(relative) || /(?:Tests?|IT|Spec|TestCase)\.(?:java|kt)$/.test(relative) || /(?:^|\/)Test[A-Z]\w*\.(?:java|kt)$/.test(relative));
}

/** The class a selection names, as the JVM spells it: package, then classes joined by `$`. */
function className(item: ITestSelection): string {
	const classes = item.kind === 'suite' ? item.path : item.path.slice(0, -1);
	return [item.scope, classes.join('$')].filter(Boolean).join('.');
}

/** Surefire's `-Dtest=`: `Class`, `Class#method`, several joined by commas. */
export function surefireFilter(named: readonly ITestSelection[]): string {
	return [...new Set(named.map(item => item.kind === 'suite' ? className(item) : `${className(item)}#${item.path.at(-1)}`))].join(',');
}

/** Gradle's `--tests`: `pkg.Class` or `pkg.Class.method` (a nested class with `$`). */
export function gradleFilters(named: readonly ITestSelection[]): string[] {
	// A Kotlin backtick name may hold spaces, which Gradle's filter takes as written.
	return [...new Set(named.map(item => item.kind === 'suite' ? `${className(item)}*` : `${className(item)}.${item.path.at(-1)}`))];
}

function wrapper(name: string, tool: string): (windows: boolean) => readonly IRuntimeCandidate[] {
	return windows => [{ exists: [windows ? `${name}.cmd` : name, ...(windows ? [`${name}.bat`] : [])], argv: ['{}'] }, { argv: [tool] }];
}

function missingJvm(tool: 'mvn' | 'gradle'): (output: string, exitCode: number | null, options: ITestCommandOptions) => IMissingTool | undefined {
	return (output, exitCode, options) => {
		const missing = missingToolchain(output, exitCode, options.windows, tool === 'mvn' ? { mvn: 'Maven (mvn; the project has no ./mvnw wrapper)' } : { gradle: 'Gradle (gradle; the project has no ./gradlew wrapper)' });
		if (missing) {
			return missing;
		}
		if (/JAVA_HOME is not (?:set|defined)|Unable to locate a Java Runtime|No Java runtime present|java: (?:command )?not found|command not found: java/.test(output)) {
			return { what: 'a JDK (java)', install: options.windows ? 'winget install EclipseAdoptium.Temurin.21.JDK' : 'brew install openjdk' };
		}
		return undefined;
	};
}

const jvmBase = {
	family: 'jvm' as const,
	globs: ['**/src/{test,integrationTest}/**/*.{java,kt}', '**/{*Test,*Tests,*IT,*Spec,*TestCase,Test*}.{java,kt}'],
	isTestFile: isJvmTestPath,
	parse: (text: string) => parseJvmTests(text),
	selectsFiles: false,
	debug: () => 'Debugging JUnit tests needs the Java extensions (Debugger for Java and Test Runner for Java), which start the JVM themselves; Volt\'s runner does not start a JVM debug session. Run the test here, or debug it from the Java extension\'s Test Explorer.',
	// A class's tests are named after it: Cart.java affects CartTest.java.
	affects: (changed: string, testFile: string) => {
		const stem = (path: string) => (path.split('/').pop() ?? '').replace(/\.(?:java|kt)$/, '').replace(/(?:Tests?|IT|Spec|TestCase)$/, '').replace(/^Test(?=[A-Z])/, '');
		return /\.(?:java|kt)$/.test(changed) && stem(changed) === stem(testFile);
	},
};

function hasGradle(folder: IFolderProbe): boolean {
	return folder.files.has('build.gradle') || folder.files.has('build.gradle.kts');
}

export const mavenAdapter: ITestAdapter = {
	...jvmBase,
	id: 'maven',
	label: 'JUnit (Maven)',
	markers: ['pom.xml', 'mvnw'],
	// A folder with both build files is run by the one whose wrapper is there, Gradle when neither is.
	detect: folder => folder.files.has('pom.xml') && (!hasGradle(folder) || folder.files.has('mvnw')) ? {} : undefined,
	runtimes: wrapper('mvnw', 'mvn'),
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const { named, allNamed } = splitSelection(selection);
		return {
			command: [...(options.runtime ?? ['mvn']).map(q), '-B', 'test', ...(allNamed ? [q(`-Dtest=${surefireFilter(named)}`), '-Dsurefire.failIfNoSpecifiedTests=false', '-DfailIfNoTests=false'] : [])].join(' '),
			report: { kind: 'project', globs: ['target/surefire-reports/TEST-*.xml', '**/target/surefire-reports/TEST-*.xml'] },
			format: 'junit-jvm',
		};
	},
	missing: missingJvm('mvn'),
};

export const gradleAdapter: ITestAdapter = {
	...jvmBase,
	id: 'gradle',
	label: 'JUnit (Gradle)',
	markers: ['build.gradle', 'build.gradle.kts', 'gradlew'],
	detect: folder => hasGradle(folder) ? {} : undefined,
	runtimes: wrapper('gradlew', 'gradle'),
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const { named, allNamed } = splitSelection(selection);
		return {
			// cleanTest: Gradle skips tests whose inputs did not change, and a rerun must run.
			command: [...(options.runtime ?? ['gradle']).map(q), 'cleanTest', 'test', '--console=plain', '--continue', ...(allNamed ? gradleFilters(named).flatMap(filter => ['--tests', q(filter)]) : [])].join(' '),
			report: { kind: 'project', globs: ['build/test-results/test/TEST-*.xml', '**/build/test-results/test/TEST-*.xml'] },
			format: 'junit-jvm',
		};
	},
	missing: missingJvm('gradle'),
};
