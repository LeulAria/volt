/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** One dependency as Agent Lab found it. */
export interface IPackageRow {
	readonly name: string;
	/** The range in package.json (`^1.2.0`). */
	readonly range: string;
	/** The version the range starts at (`1.2.0`). */
	readonly current: string;
	readonly latest?: string;
	readonly behind: { readonly major: number; readonly minor: number; readonly patch: number };
	readonly dev: boolean;
	readonly error?: string;
}

export interface DependencyReport {
	readonly project: string;
	/** The project folder (a path). */
	readonly root: string;
	readonly at: number;
	readonly registry: string;
	readonly packages: readonly IPackageRow[];
}

/** At most this many registry requests per scout, six at a time. */
const MAX_PACKAGES = 60;
const PARALLEL = 6;

/** The project: the window's folder, else the project of the chat in front (Volt's agent window opens none). */
export async function projectFolder(volt: typeof vscode.volt): Promise<vscode.Uri | undefined> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (folder) {
		return folder;
	}
	const project = await Promise.resolve(volt.chats.current()).then(chat => chat?.project, () => undefined);
	return project ? vscode.Uri.file(project) : undefined;
}

/** The project's dependencies, from its package.json. */
export async function readDependencies(folder: vscode.Uri | undefined): Promise<{ readonly name: string; readonly range: string; readonly dev: boolean }[]> {
	if (!folder) {
		throw new Error('open a project first');
	}
	const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'package.json'));
	const manifest = JSON.parse(new TextDecoder().decode(bytes)) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	const entries = (record: Record<string, string> | undefined, dev: boolean) => Object.entries(record ?? {}).filter(([, range]) => typeof range === 'string').map(([name, range]) => ({ name, range, dev }));
	return [...entries(manifest.dependencies, false), ...entries(manifest.devDependencies, true)];
}

/** Asks `registry` for each dependency's latest version. */
export async function scoutDependencies(registry: string, folder: vscode.Uri | undefined): Promise<DependencyReport> {
	if (!folder) {
		throw new Error('open a project first');
	}
	const deps = (await readDependencies(folder)).slice(0, MAX_PACKAGES);
	const base = registry.replace(/\/+$/, '');
	const rows: IPackageRow[] = new Array(deps.length);
	let next = 0;
	const worker = async () => {
		while (next < deps.length) {
			const index = next++;
			const dep = deps[index];
			const current = baseVersion(dep.range);
			try {
				// Scoped names keep their `@` and encode the slash: `@scope%2Fname`.
				const response = await fetch(`${base}/${dep.name.replace('/', '%2F')}/latest`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}
				const latest = String(((await response.json()) as { version?: unknown }).version ?? '');
				rows[index] = { ...dep, current, latest, behind: distance(current, latest) };
			} catch (err) {
				rows[index] = { ...dep, current, behind: { major: 0, minor: 0, patch: 0 }, error: err instanceof Error ? err.message : String(err) };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(PARALLEL, deps.length) }, worker));
	return { project: folder.path.split('/').pop() || 'project', root: folder.fsPath, at: Date.now(), registry: base, packages: rows };
}

/** `^1.2.3` is `1.2.3`; anything that is not a version (`workspace:*`, a URL) stays as written. */
export function baseVersion(range: string): string {
	return /(\d+\.\d+\.\d+)/.exec(range)?.[1] ?? range;
}

/** How far `current` is behind `latest`: the first part that differs, by how much. */
export function distance(current: string, latest: string): { major: number; minor: number; patch: number } {
	const a = current.split('.').map(Number);
	const b = latest.split('.').map(Number);
	if (a.length < 3 || b.length < 3 || [...a, ...b].some(Number.isNaN)) {
		return { major: 0, minor: 0, patch: 0 };
	}
	if (b[0] !== a[0]) {
		return { major: Math.max(0, b[0] - a[0]), minor: 0, patch: 0 };
	}
	if (b[1] !== a[1]) {
		return { major: 0, minor: Math.max(0, b[1] - a[1]), patch: 0 };
	}
	return { major: 0, minor: 0, patch: Math.max(0, b[2] - a[2]) };
}

export function outdated(report: DependencyReport): IPackageRow[] {
	return report.packages.filter(row => !row.error && (row.behind.major || row.behind.minor || row.behind.patch));
}

export function describeReport(report: DependencyReport, rows: readonly IPackageRow[]): string {
	const lines = rows.map(row => row.error
		? `- ${row.name} ${row.range}: not found (${row.error})`
		: `- ${row.name} ${row.range}: latest ${row.latest}${row.behind.major ? `, ${row.behind.major} major behind` : row.behind.minor ? `, ${row.behind.minor} minor behind` : row.behind.patch ? `, ${row.behind.patch} patch behind` : ', up to date'}${row.dev ? ' (dev)' : ''}`);
	return [`${report.project}: ${rows.length} dependencies (from ${report.registry}, ${new Date(report.at).toISOString()})`, ...lines].join('\n');
}

/** The message the picked agent gets. */
export function upgradePlan(report: DependencyReport): string {
	const rows = outdated(report);
	const majors = rows.filter(row => row.behind.major);
	return [
		`Agent Lab found ${rows.length} outdated npm dependencies in ${report.project}. Upgrade them in small steps:`,
		'1. Patch and minor upgrades together, then run the tests.',
		`2. Each major upgrade on its own${majors.length ? ` (${majors.map(row => row.name).join(', ')})` : ''}: read its changelog, fix what breaks, run the tests.`,
		'',
		...rows.map(row => `- ${row.name}: ${row.range} -> ^${row.latest}${row.dev ? ' (dev)' : ''}`),
	].join('\n');
}
