/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { detectRunPlanFromFiles, IRunPlan } from '../../common/runPlan.js';
import { IProjectCheckFiles } from '../../common/harness/verification.js';

export async function loadWorkspaceRunPlan(fileService: IFileService, workspace: IWorkspaceContextService): Promise<IRunPlan> {
	const root = workspace.getWorkspace().folders[0]?.uri;
	if (!root) {
		return { kind: 'unknown' };
	}
	const [indexHtml, pkg, viteTs, viteJs, nextJs, nextMjs, nextTs, pnpm, bun, yarn] = await Promise.all([
		exists(fileService, root, 'index.html'),
		exists(fileService, root, 'package.json'),
		exists(fileService, root, 'vite.config.ts'),
		exists(fileService, root, 'vite.config.js'),
		exists(fileService, root, 'next.config.js'),
		exists(fileService, root, 'next.config.mjs'),
		exists(fileService, root, 'next.config.ts'),
		exists(fileService, root, 'pnpm-lock.yaml'),
		exists(fileService, root, 'bun.lockb'),
		exists(fileService, root, 'yarn.lock'),
	]);
	let packageJson: { scripts?: Record<string, string>; packageManager?: string } | undefined;
	if (pkg) {
		try {
			const raw = await fileService.readFile(joinPath(root, 'package.json'));
			packageJson = JSON.parse(raw.value.toString());
		} catch {
			packageJson = undefined;
		}
	}
	return detectRunPlanFromFiles({
		indexHtml,
		packageJson,
		vite: viteTs || viteJs,
		next: nextJs || nextMjs || nextTs,
		lock: pnpm ? 'pnpm' : bun ? 'bun' : yarn ? 'yarn' : pkg ? 'npm' : undefined,
	});
}

export async function loadProjectCheckFiles(fileService: IFileService, root: URI | undefined): Promise<IProjectCheckFiles> {
	if (!root) {
		return {};
	}
	const [pkg, tsconfig, cargoToml, goMod, pyproject, pnpm, bun, yarn] = await Promise.all([
		exists(fileService, root, 'package.json'),
		exists(fileService, root, 'tsconfig.json'),
		exists(fileService, root, 'Cargo.toml'),
		exists(fileService, root, 'go.mod'),
		exists(fileService, root, 'pyproject.toml'),
		exists(fileService, root, 'pnpm-lock.yaml'),
		exists(fileService, root, 'bun.lockb'),
		exists(fileService, root, 'yarn.lock'),
	]);
	let packageJson: IProjectCheckFiles['packageJson'];
	if (pkg) {
		try {
			const raw = await fileService.readFile(joinPath(root, 'package.json'));
			packageJson = JSON.parse(raw.value.toString());
		} catch {
			packageJson = undefined;
		}
	}
	return {
		...(packageJson ? { packageJson } : {}),
		lock: pnpm ? 'pnpm' : bun ? 'bun' : yarn ? 'yarn' : pkg ? 'npm' : undefined,
		tsconfig,
		cargoToml,
		goMod,
		pyproject,
	};
}

async function exists(fileService: IFileService, root: URI, name: string): Promise<boolean> {
	try {
		return await fileService.exists(joinPath(root, name));
	} catch {
		return false;
	}
}
