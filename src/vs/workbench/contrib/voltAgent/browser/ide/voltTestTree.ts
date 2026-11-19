/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ResourceMap } from '../../../../../base/common/map.js';
import { isEqualOrParent, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IStaticTest, ITestAdapter } from '../../../../services/voltRuntime/common/ide/testFrameworks.js';
import { TestId } from '../../../testing/common/testId.js';
import { InternalTestItem, ITestItem, TestDiffOpType, TestItemExpandState, TestsDiff } from '../../../testing/common/testTypes.js';

/** A project Volt's runner runs: a folder set up for one framework. */
export interface IVoltTestProject {
	readonly root: URI;
	readonly adapter: ITestAdapter;
	/** What detection learned (the crate, the project file, the package manager). */
	readonly data?: Readonly<Record<string, string>>;
	/** The folder Volt scanned that holds it. */
	readonly scanRoot: URI;
}

interface INodeBase {
	readonly id: string;
	readonly label: string;
	readonly parent: VoltTestNode | undefined;
	readonly children: Map<string, VoltTestNode>;
}

export interface IVoltRootNode extends INodeBase {
	readonly type: 'root';
}

/** A folder between the scanned folder and a test file; with several scanned folders, also each of them. */
export interface IVoltFolderNode extends INodeBase {
	readonly type: 'folder';
	readonly uri: URI;
}

export interface IVoltFileNode extends INodeBase {
	readonly type: 'file';
	readonly uri: URI;
	project: IVoltTestProject;
	/** The file as its tests were last read (`mtime:size`); undefined until something needed them. */
	stamp: string | undefined;
}

export interface IVoltCaseNode extends INodeBase {
	readonly type: 'case';
	readonly kind: 'suite' | 'test';
	readonly file: IVoltFileNode;
	line: number;
	endLine: number;
	/** The names the runner knows it by: what its file prefixes (cargo's module path), suites, then its own. */
	readonly path: readonly string[];
	/** How many leading names of `path` are suites. */
	readonly suiteDepth: number;
	readonly scope?: string;
	readonly flavor?: string;
	/** One generated case of its parent test (a subtest, a parameter set): what the runner calls it. */
	readonly variant?: string;
	/** Only the runner knows it (a generated test); a re-read of the file keeps it. */
	readonly dynamic?: boolean;
}

export type VoltTestNode = IVoltRootNode | IVoltFolderNode | IVoltFileNode | IVoltCaseNode;

/** What a scan found: the folders scanned, and each test file with the project that runs it. */
export interface IVoltTestScan {
	readonly roots: readonly URI[];
	readonly files: ResourceMap<IVoltTestProject>;
}

/**
 * The tree Volt's test controller publishes to the Testing service: folder, folder, file, suite,
 * test, the way the Test Explorer shows a project. Folders and files are known from a file search
 * alone; a file's tests come later (`setTests`), when something needs them. Ids are paths of names
 * (never positions), so results and reruns survive a rescan and an edit.
 */
export class VoltTestTree {

	readonly root: IVoltRootNode;
	private readonly byId = new Map<string, VoltTestNode>();
	private readonly byFile = new ResourceMap<IVoltFileNode>();
	private roots: readonly URI[] = [];
	/** Whether files show their framework: only when the tree mixes several. */
	private mixed = false;

	constructor(private readonly controllerId: string, label: string) {
		this.root = { type: 'root', id: new TestId([controllerId]).toString(), label, parent: undefined, children: new Map() };
		this.byId.set(this.root.id, this.root);
	}

	get(id: string): VoltTestNode | undefined {
		return this.byId.get(id);
	}

	file(uri: URI): IVoltFileNode | undefined {
		return this.byFile.get(uri);
	}

	files(): IVoltFileNode[] {
		return [...this.byFile.values()];
	}

	get size(): number {
		return this.byFile.size;
	}

	/** The files at or under a node. */
	filesUnder(node: VoltTestNode): IVoltFileNode[] {
		if (node.type === 'file') {
			return [node];
		}
		if (node.type === 'case') {
			return [node.file];
		}
		const out: IVoltFileNode[] = [];
		const walk = (current: VoltTestNode) => {
			for (const child of current.children.values()) {
				if (child.type === 'file') {
					out.push(child);
				} else if (child.type === 'folder') {
					walk(child);
				}
			}
		};
		walk(node);
		return out;
	}

	/** The node of a folder Volt scanned or a folder under one, when it holds tests. */
	folder(uri: URI): IVoltFolderNode | IVoltRootNode | undefined {
		const scanRoot = this.roots.filter(root => isEqualOrParent(uri, root)).sort((a, b) => b.path.length - a.path.length)[0];
		if (!scanRoot) {
			return undefined;
		}
		let node: VoltTestNode | undefined = this.roots.length > 1 ? this.root.children.get(this.rootSegment(scanRoot)) : this.root;
		for (const segment of (relativePath(scanRoot, uri) ?? '').split('/').filter(Boolean)) {
			node = node?.children.get(segment);
		}
		return node?.type === 'folder' || node?.type === 'root' ? node : undefined;
	}

	/** The tests of a file that run on their own: tests, and not the parts under them. */
	unitsOf(node: VoltTestNode): IVoltCaseNode[] {
		if (node.type === 'case' && node.kind === 'test') {
			return [node];
		}
		const out: IVoltCaseNode[] = [];
		for (const child of node.children.values()) {
			if (child.type === 'case') {
				out.push(...this.unitsOf(child));
			}
		}
		return out;
	}

	/** The item the Testing service shows for a node. */
	item(node: VoltTestNode): ITestItem {
		const range = node.type === 'case' ? new Range(node.line, 1, node.endLine, 1) : null;
		return {
			extId: node.id,
			label: node.label,
			tags: [],
			busy: false,
			uri: node.type === 'file' ? node.uri : node.type === 'case' ? node.file.uri : undefined,
			range,
			description: node.type === 'file' && this.mixed ? node.project.adapter.label : null,
			error: null,
			// Folders before files; a file's tests in source order.
			sortText: node.type === 'folder' ? `0 ${node.label}` : node.type === 'file' ? `1 ${node.label}` : node.type === 'case' ? String(node.line).padStart(6, '0') : null,
		};
	}

	/** The items from the root down to a node, for a run's own tree. */
	chain(node: VoltTestNode): ITestItem[] {
		const out: ITestItem[] = [];
		for (let current: VoltTestNode | undefined = node; current; current = current.parent) {
			out.unshift(this.item(current));
		}
		return out;
	}

	private internal(node: VoltTestNode): InternalTestItem {
		// A file's tests are read when it is expanded; folders are open so a new project shows its files.
		const expand = node.type === 'file' ? (node.stamp === undefined ? TestItemExpandState.Expandable : TestItemExpandState.Expanded)
			: node.type === 'case' ? (node.children.size ? TestItemExpandState.Expanded : TestItemExpandState.NotExpandable)
				: TestItemExpandState.Expanded;
		return { controllerId: this.controllerId, expand, item: this.item(node) };
	}

	private rootSegment(root: URI): string {
		const name = root.path.split('/').filter(Boolean).pop() ?? root.path;
		// Two scanned folders with one name (a project and its worktree's copy): the parent tells them apart.
		const twins = this.roots.filter(other => (other.path.split('/').filter(Boolean).pop() ?? other.path) === name);
		return twins.length > 1 ? `${name} (${root.path.split('/').filter(Boolean).slice(-2, -1)[0] ?? ''})` : name;
	}

	private register(node: VoltTestNode, segment: string, diff: TestsDiff): void {
		node.parent!.children.set(segment, node);
		this.byId.set(node.id, node);
		if (node.type === 'file') {
			this.byFile.set(node.uri, node);
		}
		diff.push({ op: TestDiffOpType.Add, item: this.internal(node) });
	}

	private unregister(node: VoltTestNode): void {
		this.byId.delete(node.id);
		if (node.type === 'file') {
			this.byFile.delete(node.uri);
		}
		for (const child of node.children.values()) {
			this.unregister(child);
		}
	}

	/** Removes a node and, going up, every folder left without a test file. */
	private detach(node: VoltTestNode, diff: TestsDiff): void {
		let top = node;
		while (top.parent && top.parent.type === 'folder' && top.parent.children.size === 1) {
			top = top.parent;
		}
		for (const [segment, child] of top.parent?.children ?? []) {
			if (child === top) {
				top.parent!.children.delete(segment);
			}
		}
		this.unregister(top);
		diff.push({ op: TestDiffOpType.Remove, itemId: top.id });
	}

	private ensureFile(uri: URI, project: IVoltTestProject, diff: TestsDiff): IVoltFileNode | undefined {
		const existing = this.byFile.get(uri);
		if (existing) {
			if (existing.project.adapter !== project.adapter || existing.project.root.toString() !== project.root.toString()) {
				// Another framework runs it now: its tests are read again when next needed.
				existing.project = project;
				existing.stamp = undefined;
				for (const child of [...existing.children.values()]) {
					this.detach(child, diff);
				}
				diff.push({ op: TestDiffOpType.Update, item: { extId: existing.id, expand: TestItemExpandState.Expandable, item: { description: this.item(existing).description } } });
			} else {
				existing.project = project;
			}
			return existing;
		}
		const relative = relativePath(project.scanRoot, uri);
		if (!relative) {
			return undefined;
		}
		const segments = relative.split('/').filter(Boolean);
		let parent: VoltTestNode = this.root;
		let folder = project.scanRoot;
		if (this.roots.length > 1) {
			const segment = this.rootSegment(project.scanRoot);
			let node = parent.children.get(segment);
			if (!node) {
				node = { type: 'folder', id: TestId.joinToString(parent.id, segment), label: segment, parent, children: new Map(), uri: folder };
				this.register(node, segment, diff);
			}
			parent = node;
		}
		for (const segment of segments.slice(0, -1)) {
			folder = URI.joinPath(folder, segment);
			let node = parent.children.get(segment);
			if (!node) {
				node = { type: 'folder', id: TestId.joinToString(parent.id, segment), label: segment, parent, children: new Map(), uri: folder };
				this.register(node, segment, diff);
			}
			parent = node;
		}
		const name = segments[segments.length - 1];
		const file: IVoltFileNode = { type: 'file', id: TestId.joinToString(parent.id, name), label: name, parent, children: new Map(), uri, project, stamp: undefined };
		this.register(file, name, diff);
		return file;
	}

	/**
	 * Takes a scan's result: files that are gone leave, new ones come, and the ones that stay keep
	 * the tests already read from them. Returns the diff to publish.
	 */
	setScan(scan: IVoltTestScan): TestsDiff {
		const diff: TestsDiff = [];
		const reshaped = (this.roots.length > 1) !== (scan.roots.length > 1) || (scan.roots.length > 1 && this.roots.map(root => root.toString()).join('\n') !== scan.roots.map(root => root.toString()).join('\n'));
		const mixed = new Set([...scan.files.values()].map(project => project.adapter.id)).size > 1;
		if (reshaped || mixed !== this.mixed) {
			// The top level changes shape (one scanned folder shows its folders directly, several show themselves): publish it again.
			for (const child of [...this.root.children.values()]) {
				this.root.children.clear();
				this.unregister(child);
				diff.push({ op: TestDiffOpType.Remove, itemId: child.id });
			}
		}
		this.roots = scan.roots;
		this.mixed = mixed;
		for (const file of this.files()) {
			if (!scan.files.has(file.uri)) {
				this.detach(file, diff);
			}
		}
		// Sorted, so parents are added in a stable order.
		for (const [uri, project] of [...scan.files].sort(([a], [b]) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
			this.ensureFile(uri, project, diff);
		}
		return diff;
	}

	addFile(uri: URI, project: IVoltTestProject): { readonly file: IVoltFileNode | undefined; readonly diff: TestsDiff } {
		const diff: TestsDiff = [];
		return { file: this.ensureFile(uri, project, diff), diff };
	}

	removeFile(uri: URI): TestsDiff {
		const diff: TestsDiff = [];
		const file = this.byFile.get(uri);
		if (file) {
			this.detach(file, diff);
		}
		return diff;
	}

	/**
	 * Sets the tests a file declares. Tests that are still there keep their ids (and so their
	 * results); only what changed is published. A file without tests leaves the tree.
	 */
	setTests(file: IVoltFileNode, tests: readonly IStaticTest[], stamp: string, prefix: readonly string[]): TestsDiff {
		const diff: TestsDiff = [];
		if (!tests.length && ![...file.children.values()].some(child => child.type === 'case' && child.dynamic)) {
			this.detach(file, diff);
			return diff;
		}
		const wasRead = file.stamp !== undefined;
		file.stamp = stamp;
		const sync = (parent: IVoltFileNode | IVoltCaseNode, declared: readonly IStaticTest[], path: readonly string[], suiteDepth: number, scope: string | undefined) => {
			const seen = new Set<string>();
			const used = new Map<string, number>();
			for (const test of declared) {
				// Two tests with one name in one suite: the second is "name#2", wherever its line moves.
				const count = (used.get(test.name) ?? 0) + 1;
				used.set(test.name, count);
				const segment = count === 1 ? test.name : `${test.name}#${count}`;
				seen.add(segment);
				const ownPath = [...path, test.name];
				const ownScope = test.scope ?? scope;
				let node = parent.children.get(segment) as IVoltCaseNode | undefined;
				if (node && (node.kind !== test.kind || node.dynamic)) {
					this.detach(node, diff);
					node = undefined;
				}
				if (!node) {
					node = { type: 'case', kind: test.kind, id: TestId.joinToString(parent.id, segment), label: test.name, parent, children: new Map(), file, line: test.line, endLine: test.endLine, path: ownPath, suiteDepth, ...(ownScope ? { scope: ownScope } : {}), ...(test.flavor ? { flavor: test.flavor } : {}) };
					this.register(node, segment, diff);
				} else if (node.line !== test.line || node.endLine !== test.endLine) {
					node.line = test.line;
					node.endLine = test.endLine;
					const item = this.item(node);
					diff.push({ op: TestDiffOpType.Update, item: { extId: node.id, item: { range: item.range, sortText: item.sortText } } });
				}
				sync(node, test.children, ownPath, test.kind === 'suite' ? suiteDepth + 1 : suiteDepth, ownScope);
			}
			for (const [segment, child] of [...parent.children]) {
				// Generated tests and cases stay: only a run knows whether they still exist.
				if (child.type === 'case' && !seen.has(segment) && !child.dynamic && !child.variant) {
					this.detach(child, diff);
				}
			}
		};
		sync(file, tests, prefix, prefix.length, undefined);
		if (!wasRead) {
			diff.push({ op: TestDiffOpType.Update, item: { extId: file.id, expand: TestItemExpandState.Expanded } });
		}
		return diff;
	}

	/** The test in a file the runner calls `path` (in `scope`, when both sides name one). */
	find(file: IVoltFileNode, path: readonly string[], scope?: string): IVoltCaseNode | undefined {
		const wanted = path.join('\u0000');
		let found: IVoltCaseNode | undefined;
		const walk = (node: VoltTestNode) => {
			for (const child of node.children.values()) {
				if (found || child.type !== 'case') {
					continue;
				}
				if (!child.variant && child.path.join('\u0000') === wanted && (!scope || !child.scope || child.scope === scope)) {
					found = child;
					return;
				}
				walk(child);
			}
		};
		walk(file);
		return found;
	}

	/**
	 * The declared test a generated name comes from: `fib(%i) is %i` or `handles ${input}` in the
	 * file, `fib(1) is 1` from the runner. The suites must match exactly.
	 */
	findTemplate(file: IVoltFileNode, path: readonly string[]): IVoltCaseNode | undefined {
		const wanted = path.at(-1) ?? '';
		let found: IVoltCaseNode | undefined;
		const walk = (node: VoltTestNode) => {
			for (const child of node.children.values()) {
				if (found || child.type !== 'case' || child.variant || child.dynamic) {
					continue;
				}
				if (child.kind === 'test' && child.path.length === path.length && /%[sdifjoOp#]|\$\{|\$\w/.test(child.label) && child.path.slice(0, -1).every((name, index) => name === path[index])) {
					const pattern = child.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%[sdifjoOp#]|\\\$\\\{[^}]*\\\}|\\\$[\w.]+/g, '.*');
					if (new RegExp(`^${pattern}$`).test(wanted)) {
						found = child;
						return;
					}
				}
				walk(child);
			}
		};
		walk(file);
		return found;
	}

	/** The innermost declared test or suite around a line. */
	at(file: IVoltFileNode, line: number): IVoltCaseNode | undefined {
		let best: IVoltCaseNode | undefined;
		const walk = (node: VoltTestNode) => {
			for (const child of node.children.values()) {
				if (child.type === 'case' && !child.dynamic && !child.variant && child.line <= line && child.endLine >= line) {
					best = child;
					walk(child);
				}
			}
		};
		walk(file);
		return best;
	}

	/** One generated case of a test (a subtest, a parameter set), added under it the first time a run reports it. */
	variant(parent: IVoltCaseNode, variant: string): { readonly node: IVoltCaseNode; readonly diff: TestsDiff } {
		const diff: TestsDiff = [];
		const existing = parent.children.get(variant);
		if (existing?.type === 'case') {
			return { node: existing, diff };
		}
		const node: IVoltCaseNode = { type: 'case', kind: 'test', id: TestId.joinToString(parent.id, variant), label: variant, parent, children: new Map(), file: parent.file, line: parent.line, endLine: parent.endLine, path: parent.path, suiteDepth: parent.suiteDepth, ...(parent.scope ? { scope: parent.scope } : {}), ...(parent.flavor ? { flavor: parent.flavor } : {}), variant };
		if (!parent.children.size) {
			diff.push({ op: TestDiffOpType.Update, item: { extId: parent.id, expand: TestItemExpandState.Expanded } });
		}
		this.register(node, variant, diff);
		return { node, diff };
	}

	/** A test only the runner knows (made by a loop or a table), added under its file. */
	dynamic(file: IVoltFileNode, path: readonly string[], line: number | undefined, scope: string | undefined): { readonly node: IVoltCaseNode; readonly diff: TestsDiff } {
		const diff: TestsDiff = [];
		const segment = path.join(' \u203a ');
		const existing = file.children.get(segment);
		if (existing?.type === 'case') {
			return { node: existing, diff };
		}
		const at = line ?? 1;
		const node: IVoltCaseNode = { type: 'case', kind: 'test', id: TestId.joinToString(file.id, segment), label: segment, parent: file, children: new Map(), file, line: at, endLine: at, path, suiteDepth: Math.max(0, path.length - 1), ...(scope ? { scope } : {}), dynamic: true };
		this.register(node, segment, diff);
		return { node, diff };
	}
}
