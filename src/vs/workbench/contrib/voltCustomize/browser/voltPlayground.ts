/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { runGit } from '../../voltAgent/browser/home/agentGitRun.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { VOLT_LAYOUTS_DIR, VOLT_LOOKS_DIR, VOLT_PLAYGROUND_DIR, VOLT_PLAYGROUND_MARKER, voltPlaygroundDraft } from '../common/voltCustomizeDocs.js';
import { parseVoltCustomizeJson, VOLT_HOME_SOURCE, voltCustomizeId, voltCustomizeSlug } from '../common/voltCustomizeModel.js';
import { IVoltCustomizeService } from './voltCustomizeService.js';

/** Installed snapshots of drafts, so deleting a draft never breaks what was installed from it. */
const INSTALLED_DIR = 'extensions';

/** Draft files that are for the agent working on it, not for the extension. */
const DRAFT_ONLY_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);

const GIT_TIMEOUT_MS = 30_000;

export interface IVoltDraft {
	readonly folder: URI;
	readonly name: string;
	readonly label: string;
	readonly publisher: string;
	readonly version: string;
}

function home(customize: IVoltCustomizeService): URI {
	if (!customize.home) {
		throw new Error('The customize folder is not ready yet.');
	}
	return customize.home;
}

async function readManifest(fileService: IFileService, folder: URI): Promise<Record<string, unknown> | undefined> {
	try {
		return parseVoltCustomizeJson((await fileService.readFile(joinPath(folder, 'package.json'))).value.toString()).value;
	} catch {
		return undefined;
	}
}

export async function readDraft(fileService: IFileService, folder: URI): Promise<IVoltDraft | undefined> {
	const manifest = await readManifest(fileService, folder);
	if (!manifest || !manifest[VOLT_PLAYGROUND_MARKER]) {
		return undefined;
	}
	const name = typeof manifest.name === 'string' ? manifest.name : basename(folder);
	return {
		folder,
		name,
		label: typeof manifest.displayName === 'string' ? manifest.displayName : name,
		publisher: typeof manifest.publisher === 'string' ? manifest.publisher : 'local',
		version: typeof manifest.version === 'string' ? manifest.version : '0.0.1',
	};
}

export async function listDrafts(fileService: IFileService, customize: IVoltCustomizeService): Promise<IVoltDraft[]> {
	const root = joinPath(home(customize), VOLT_PLAYGROUND_DIR);
	let folders: URI[];
	try {
		folders = ((await fileService.resolve(root)).children ?? []).filter(child => child.isDirectory).map(child => child.resource);
	} catch {
		return [];
	}
	const drafts = await Promise.all(folders.map(folder => readDraft(fileService, folder)));
	return drafts.filter((draft): draft is IVoltDraft => !!draft).sort((a, b) => a.label.localeCompare(b.label));
}

/** A new draft folder starting from the layout and look in use; a taken name gets a number. */
export async function createDraft(fileService: IFileService, customize: IVoltCustomizeService, label: string): Promise<URI> {
	const root = joinPath(home(customize), VOLT_PLAYGROUND_DIR);
	const base = voltCustomizeSlug(label);
	let name = base;
	for (let n = 2; await fileService.exists(joinPath(root, name)); n++) {
		name = `${base}-${n}`;
	}
	const folder = joinPath(root, name);
	const files = voltPlaygroundDraft(name === base ? label : `${label} ${name.slice(base.length + 1)}`, customize.activeLayoutId, customize.activeLookId || undefined);
	for (const [path, text] of Object.entries(files)) {
		await fileService.writeFile(joinPath(folder, path), VSBuffer.fromString(text));
	}
	return folder;
}

/**
 * Makes the draft a git repository with its starting files as the first commit, so the Changes
 * view shows everything the agent or the devtools changed since. Returns false when git can't run;
 * a draft that already has `.git` is left alone.
 */
export async function ensureDraftRepository(fileService: IFileService, stdio: IVoltStdioService, draft: IVoltDraft): Promise<boolean> {
	if (draft.folder.scheme !== Schemas.file) {
		return false;
	}
	if (await fileService.exists(joinPath(draft.folder, '.git'))) {
		return true;
	}
	const cwd = draft.folder.fsPath;
	const init = await runGit(stdio, cwd, ['init', '-q'], GIT_TIMEOUT_MS);
	if (init.exitCode !== 0) {
		return false;
	}
	await runGit(stdio, cwd, ['add', '-A'], GIT_TIMEOUT_MS);
	// Its own identity and no signing: a baseline in a scratch folder must not prompt or fail.
	const commit = await runGit(stdio, cwd, ['-c', 'user.name=Volt', '-c', 'user.email=volt@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', `Start ${draft.label}`], GIT_TIMEOUT_MS);
	return commit.exitCode === 0;
}

/** The Playground: a new window on the draft folder. Its chat works in the draft. */
export function openPlayground(hostService: IHostService, folder: URI): Promise<void> {
	return hostService.openWindow([{ folderUri: folder }], { forceNewWindow: true });
}

/**
 * Keeps the draft as the person's own look and layout: copies its files into looks/ and layouts/
 * under the draft's name and switches to them. Applying again updates them.
 */
export async function applyDraft(fileService: IFileService, customize: IVoltCustomizeService, draft: IVoltDraft): Promise<void> {
	const root = home(customize);
	const name = voltCustomizeSlug(draft.name);
	await fileService.copy(joinPath(draft.folder, 'look.json'), joinPath(root, VOLT_LOOKS_DIR, `${name}.json`), true);
	await fileService.copy(joinPath(draft.folder, 'layout.json'), joinPath(root, VOLT_LAYOUTS_DIR, `${name}.json`), true);
	await customize.setLayout(voltCustomizeId(VOLT_HOME_SOURCE, name));
	await customize.setLook(voltCustomizeId(VOLT_HOME_SOURCE, name));
}

/**
 * Installs the draft as an extension, as any extension from a folder: a copy goes to
 * extensions/<publisher>.<name>-<version> first, then into the profile's extensions. Returns the
 * extension id; its look and layout are `<id>/<name>`.
 */
export async function installDraft(fileService: IFileService, extensionManagementService: IWorkbenchExtensionManagementService, customize: IVoltCustomizeService, draft: IVoltDraft): Promise<string> {
	const id = `${draft.publisher}.${draft.name}`;
	const target = joinPath(home(customize), INSTALLED_DIR, `${id}-${draft.version}`);
	if (await fileService.exists(target)) {
		await fileService.del(target, { recursive: true });
	}
	const children = (await fileService.resolve(draft.folder)).children ?? [];
	for (const child of children) {
		const childName = basename(child.resource);
		if (DRAFT_ONLY_FILES.has(childName) || childName.startsWith('.') || childName.endsWith('.error')) {
			continue;
		}
		await fileService.copy(child.resource, joinPath(target, childName), true);
	}
	// The installed copy is an ordinary extension, not a draft.
	const manifest = await readManifest(fileService, target);
	if (manifest) {
		delete manifest[VOLT_PLAYGROUND_MARKER];
		await fileService.writeFile(joinPath(target, 'package.json'), VSBuffer.fromString(JSON.stringify(manifest, undefined, '\t') + '\n'));
	}
	await extensionManagementService.installFromLocation(target);
	return id;
}

/**
 * Copies a draft into a new one named "<label> copy" (numbered when taken). Its history is not
 * copied: the clone gets its own baseline the first time its Playground opens.
 */
export async function cloneDraft(fileService: IFileService, customize: IVoltCustomizeService, draft: IVoltDraft): Promise<URI> {
	const root = joinPath(home(customize), VOLT_PLAYGROUND_DIR);
	const label = `${draft.label} copy`;
	const base = voltCustomizeSlug(label);
	let name = base;
	for (let n = 2; await fileService.exists(joinPath(root, name)); n++) {
		name = `${base}-${n}`;
	}
	const folder = joinPath(root, name);
	for (const child of (await fileService.resolve(draft.folder)).children ?? []) {
		const childName = basename(child.resource);
		if (childName === '.git' || childName.endsWith('.error')) {
			continue;
		}
		await fileService.copy(child.resource, joinPath(folder, childName), true);
	}
	const manifest = await readManifest(fileService, folder);
	if (manifest) {
		manifest.name = name;
		manifest.displayName = name === base ? label : `${label} ${name.slice(base.length + 1)}`;
		await fileService.writeFile(joinPath(folder, 'package.json'), VSBuffer.fromString(JSON.stringify(manifest, undefined, '\t') + '\n'));
	}
	return folder;
}

export async function deleteDraft(fileService: IFileService, draft: IVoltDraft): Promise<void> {
	await fileService.del(draft.folder, { recursive: true, useTrash: true }).catch(() => fileService.del(draft.folder, { recursive: true }));
}
