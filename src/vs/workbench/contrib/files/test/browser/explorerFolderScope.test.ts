/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { extUriIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { createFileStat, NullFilesConfigurationService, TestContextService, TestFileService } from '../../../../test/common/workbenchTestServices.js';
import { ExplorerService } from '../../browser/explorerService.js';
import { IExplorerView } from '../../browser/files.js';
import { ExplorerItem, ExplorerModel } from '../../common/explorerModel.js';
import { SortOrder } from '../../common/files.js';

suite('Explorer folder switching', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	function setup() {
		const files = disposables.add(new TestFileService());
		const context = new TestContextService();
		const configuration = new TestConfigurationService({ explorer: { fileNesting: { enabled: false } } });
		const model = disposables.add(new ExplorerModel(context, { extUri: extUriIgnorePathCase } as unknown as IUriIdentityService, files, configuration, NullFilesConfigurationService));
		return { model, files, context, configuration };
	}

	function setupService() {
		const { files, context, configuration } = setup();
		const service = disposables.add(new ExplorerService(files, configuration, context, {} as IClipboardService, {} as IEditorService,
			{ extUri: extUriIgnorePathCase } as unknown as IUriIdentityService, {} as IBulkEditService, {} as IProgressService,
			{ onDidChangeFocus: Event.None } as IHostService, NullFilesConfigurationService));
		let refreshes = 0;
		service.registerView({ setTreeInput: async () => { }, refresh: async () => { refreshes++; } } as unknown as IExplorerView);
		return { service, files, refreshes: () => refreshes };
	}

	test('restores a resolved tree without disk reads or workspace changes', async () => {
		const { model, files, context, configuration } = setup();
		const workspace = context.getWorkspace();
		const workspaceRoots = model.roots;
		const folder = URI.file('/projects/a');
		model.setFolder(folder);
		const root = model.roots[0];
		const child = new ExplorerItem(URI.joinPath(folder, 'hello.ts'), files, configuration, NullFilesConfigurationService, root, false);
		root.addChild(child);
		root._isDirectoryResolved = true;
		model.setFolder(URI.file('/projects/b'));
		assert.strictEqual(model.findClosest(child.resource), null);
		model.setFolder(folder);
		files.resolve = async () => { throw new Error('A cached tree must not read from disk'); };
		assert.strictEqual(model.roots[0], root);
		assert.deepStrictEqual(await root.fetchChildren(SortOrder.Default), [child]);
		assert.strictEqual(model.findClosest(child.resource), child);
		assert.strictEqual(context.getWorkspace(), workspace);
		model.setFolder(undefined);
		assert.strictEqual(model.roots, workspaceRoots);
	});

	test('same folder with different casing does not recreate the tree', () => {
		const { model } = setup();
		model.setFolder(URI.file('/Projects/Alpha'));
		const root = model.roots[0];
		let changes = 0;
		disposables.add(model.onDidChangeRoots(() => changes++));
		model.setFolder(URI.file('/projects/alpha'));
		assert.strictEqual(model.roots[0], root);
		assert.strictEqual(changes, 0);
	});

	test('evicts least recently visited trees while keeping recent projects warm', () => {
		const { model } = setup();
		model.setFolder(URI.file('/projects/old'));
		const oldest = model.roots[0];
		for (let i = 0; i < 10; i++) {
			model.setFolder(URI.file(`/projects/${i}`));
		}
		const recent = model.roots[0];
		model.setFolder(URI.file('/projects/old'));
		assert.notStrictEqual(model.roots[0], oldest);
		model.setFolder(URI.file('/projects/9'));
		assert.strictEqual(model.roots[0], recent);
	});

	test('an old sidebar releasing its folder cannot reset the new sidebar or its watcher', () => {
		const { service, files } = setupService();
		const watching = new Set<string>();
		files.watch = resource => {
			watching.add(resource.path);
			return Object.assign(toDisposable(() => watching.delete(resource.path)), { onDidChange: Event.None });
		};
		const first = disposables.add(service.scopeToFolder(URI.file('/projects/a')));
		const second = disposables.add(service.scopeToFolder(URI.file('/projects/b')));
		first.dispose();
		assert.strictEqual(service.scopedFolder?.path, '/projects/b');
		assert.deepStrictEqual([...watching], ['/projects/b']);
		second.dispose();
		assert.strictEqual(service.scopedFolder, undefined);
		assert.strictEqual(watching.size, 0);
	});

	test('a cached folder remains visible until its background refresh completes', async () => {
		const { service, files, refreshes } = setupService();
		const folder = URI.file('/projects/a');
		disposables.add(service.scopeToFolder(folder));
		const root = service.roots[0];
		root._isDirectoryResolved = true;
		disposables.add(service.scopeToFolder(URI.file('/projects/b')));
		const disk = new DeferredPromise<ReturnType<typeof createFileStat>>();
		files.resolve = () => disk.p;
		disposables.add(service.scopeToFolder(folder));
		assert.strictEqual(service.roots[0], root);
		assert.strictEqual(root.isDirectoryResolved, true);
		assert.strictEqual(refreshes(), 0);
		await Promise.resolve();
		await disk.complete(createFileStat(folder, false, false, true, false, [{ resource: URI.joinPath(folder, 'new.txt'), isFile: true }]));
		await Promise.resolve();
		assert.ok(root.getChild('new.txt'));
		assert.strictEqual(refreshes(), 1);
	});

	test('a refresh finishing after another switch cannot modify the selected tree', async () => {
		const { service, files, refreshes } = setupService();
		const folder = URI.file('/projects/a');
		disposables.add(service.scopeToFolder(folder));
		const oldRoot = service.roots[0];
		oldRoot._isDirectoryResolved = true;
		disposables.add(service.scopeToFolder(URI.file('/projects/b')));
		const disk = new DeferredPromise<ReturnType<typeof createFileStat>>();
		files.resolve = () => disk.p;
		disposables.add(service.scopeToFolder(folder));
		await Promise.resolve();
		disposables.add(service.scopeToFolder(URI.file('/projects/b')));
		await disk.complete(createFileStat(folder, false, false, true, false, [{ resource: URI.joinPath(folder, 'late.txt'), isFile: true }]));
		await Promise.resolve();
		assert.strictEqual(service.roots[0].resource.path, '/projects/b');
		assert.strictEqual(oldRoot.getChild('late.txt'), undefined);
		assert.strictEqual(refreshes(), 0);
	});
});
