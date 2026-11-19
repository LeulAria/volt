/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { braceDelta, fillTestEnds, IMissingTool, IOpenTest, IStaticTest, ITestAdapter, ITestCommandOptions, ITestSelection, missingToolchain, pruneEmptySuites, shellQuote, splitSelection } from './testAdapter.js';

const TEST_ATTRIBUTE = /\[\s*(?:\w+\.)*(?:Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod|SkippableFact|SkippableTheory|StaFact|UIFact|Property)(?:Attribute)?\s*(?:\(|\]|,)/;
const CS_MODIFIERS = '(?:(?:public|private|protected|internal|static|async|virtual|override|sealed|new|unsafe|partial|abstract|readonly|file)\\s+)*';
const CS_CLASS = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*${CS_MODIFIERS}(?:class|record|struct)\\s+(\\w+)`);
const CS_METHOD = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*${CS_MODIFIERS}[\\w<>\\[\\],.?]+(?:\\s*<[^(]*>)?\\s+(\\w+)\\s*(?:<[^(]*>)?\\s*\\(`);

/**
 * The tests of a C# file: classes (nested ones too) with the methods xUnit (`[Fact]`,
 * `[Theory]`), NUnit (`[Test]`, `[TestCase]`) and MSTest (`[TestMethod]`) mark. A top-level
 * class carries its namespace, which the runner's filter needs.
 */
export function parseCsharpTests(text: string): IStaticTest[] {
	const roots: IStaticTest[] = [];
	const classes: { readonly node: IOpenTest; readonly depth: number }[] = [];
	const namespaces: { readonly name: string; readonly depth: number }[] = [];
	let fileNamespace = '';
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
		if (open >= 0 && !/["'].*\/\*/.test(line)) {
			inBlockComment = true;
			line = line.slice(0, open);
		}
		if (/^\s*\/\//.test(line)) {
			continue;
		}
		const namespace = /^\s*namespace\s+([\w.]+)\s*(;)?/.exec(line);
		if (namespace) {
			if (namespace[2]) {
				fileNamespace = namespace[1];
			} else {
				namespaces.push({ name: namespace[1], depth });
			}
		}
		if (TEST_ATTRIBUTE.test(line)) {
			pending = true;
		}
		const cls = CS_CLASS.exec(line);
		if (cls) {
			const scope = [fileNamespace, ...namespaces.map(item => item.name)].filter(Boolean).join('.');
			const node: IOpenTest = { name: cls[1], kind: 'suite', line: index + 1, endLine: index + 1, children: [], ...(!classes.length && scope ? { scope } : {}) };
			(classes.at(-1)?.node.children ?? roots).push(node);
			classes.push({ node, depth });
			// [TestClass] and [TestFixture] sit on the class, not on a test.
			pending = pending && TEST_ATTRIBUTE.test(line.slice(line.indexOf(cls[0]) + cls[0].length));
		} else if (pending && classes.length) {
			const method = CS_METHOD.exec(line.replace(/^(\s*\[[^\]]*\])+/, ''));
			if (method && !/^(?:if|for|foreach|while|switch|using|lock|catch|return|new)$/.test(method[1])) {
				classes[classes.length - 1].node.children.push({ name: method[1], kind: 'test', line: index + 1, endLine: index + 1, children: [] });
				pending = false;
			}
		}
		depth += braceDelta(line, false, true);
		while (classes.length && depth <= classes[classes.length - 1].depth && index + 1 > classes[classes.length - 1].node.line) {
			classes.pop()!.node.endLine = index + 1;
		}
		while (namespaces.length && depth <= namespaces[namespaces.length - 1].depth && !namespace) {
			namespaces.pop();
		}
	}
	for (const open of classes) {
		open.node.endLine = lines.length;
	}
	const pruned = pruneEmptySuites(roots);
	fillTestEnds(pruned, lines.length);
	return pruned;
}

/** The fully qualified name `dotnet test --filter` matches: namespace, classes (nested ones joined by `+`), method. */
export function dotnetQualifiedName(item: ITestSelection): string {
	const classes = item.kind === 'suite' ? item.path : item.path.slice(0, -1);
	const type = [item.scope, classes.join('+')].filter(Boolean).join('.');
	return item.kind === 'suite' ? type : `${type}.${item.path.at(-1)}`;
}

/** `--filter` for a selection: a test by its exact name (and its data rows, which NUnit names `Name(args)`), a class by its prefix. */
export function dotnetFilter(named: readonly ITestSelection[]): string {
	const escape = (value: string) => value.replace(/([\\()&|=!~])/g, '\\$1');
	return [...new Set(named.map(item => {
		const name = escape(dotnetQualifiedName(item));
		return item.kind === 'suite' ? `FullyQualifiedName~${name}.|FullyQualifiedName~${name}+` : `FullyQualifiedName=${name}|FullyQualifiedName~${name}\\(`;
	}))].join('|');
}

const PROJECT_FILE = /\.(?:cs|fs|vb)proj$/;

function isTestProject(text: string): boolean {
	return /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true|Include="(?:xunit|xunit\.v3|NUnit|MSTest|MSTest\.TestFramework|TUnit)"|Sdk="MSTest\.Sdk/i.test(text);
}

function missingDotnet(output: string, exitCode: number | null, options: ITestCommandOptions): IMissingTool | undefined {
	const tool = missingToolchain(output, exitCode, options.windows, { dotnet: 'the .NET SDK (dotnet)' });
	if (tool) {
		return tool;
	}
	if (/No \.NET SDKs were found|The command could not be loaded, possibly because|A compatible \.NET SDK was not found/.test(output)) {
		return { what: 'the .NET SDK (only a runtime is installed)', install: options.windows ? 'winget install Microsoft.DotNet.SDK.9' : 'brew install dotnet (or https://dot.net/download)' };
	}
	if (/Could not find data ?collector 'XPlat Code Coverage'|Unable to find a datacollector with friendly name 'XPlat Code Coverage'/i.test(output)) {
		return { what: 'coverlet.collector (coverage for dotnet test)', install: `dotnet add ${options.data?.project ?? ''} package coverlet.collector`.replace(/\s+/g, ' ') };
	}
	return undefined;
}

export const dotnetAdapter: ITestAdapter = {
	id: 'dotnet',
	label: 'dotnet test',
	family: 'dotnet',
	globs: ['**/*.cs'],
	contentPattern: '\\[\\s*(?:\\w+\\.)*(?:Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod|SkippableFact|SkippableTheory)(?:Attribute)?\\s*[(\\],]',
	markers: ['*.csproj', '*.fsproj', '*.vbproj'],
	isTestFile: relative => relative.endsWith('.cs') && !/(?:^|\/)(?:bin|obj)\//.test(relative),
	detect(folder) {
		const project = [...folder.files].find(([name, text]) => PROJECT_FILE.test(name) && isTestProject(text));
		return project ? { data: { project: project[0] } } : undefined;
	},
	parse: text => parseCsharpTests(text),
	selectsFiles: false,
	coverage: true,
	command(selection, options) {
		const q = (value: string) => shellQuote(value, options.windows);
		const { named, allNamed } = splitSelection(selection);
		return {
			command: [
				'dotnet', 'test', ...(options.data?.project ? [q(options.data.project)] : []), '--nologo',
				'--logger', q('trx'), '--results-directory', q(options.reportFile),
				// One line per test as it finishes (live results).
				'--logger', q('console;verbosity=normal'),
				...(options.coverage ? ['--collect', q('XPlat Code Coverage')] : []),
				...(allNamed ? ['--filter', q(dotnetFilter(named))] : []),
			].join(' '),
			report: { kind: 'folder', path: options.reportFile, extension: '.trx' },
			format: 'trx',
			stream: 'dotnet-console',
			...(options.coverage ? { coverageFile: options.reportFile } : {}),
		};
	},
	missing: missingDotnet,
	debug: () => 'Debugging .NET tests needs the C# Dev Kit, which attaches to the test host itself; Volt\'s runner does not start a .NET debug session. Run the test here, or debug it from the C# extension\'s Test Explorer.',
	// Any source of the test project, or of a project beside it, can change a test's result.
	affects: (changed, testFile) => changed.endsWith('.cs') && (changed.split('/').pop() ?? '').replace(/\.cs$/, '') === (testFile.split('/').pop() ?? '').replace(/Tests?\.cs$/, ''),
};
