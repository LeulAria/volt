/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type RunPlanKind = 'static' | 'vite' | 'next' | 'node' | 'unknown';

export interface IRunPlanFiles {
	readonly indexHtml?: boolean;
	readonly packageJson?: { scripts?: Record<string, string>; packageManager?: string };
	readonly vite?: boolean;
	readonly next?: boolean;
	readonly lock?: 'pnpm' | 'bun' | 'yarn' | 'npm';
}

export interface IRunPlan {
	readonly kind: RunPlanKind;
	readonly start?: string;
	readonly previewUrl?: string;
}

export function detectRunPlanFromFiles(files: IRunPlanFiles): IRunPlan {
	const pm = packageManager(files);
	const scripts = files.packageJson?.scripts ?? {};
	if (scripts.dev) {
		return {
			kind: files.vite ? 'vite' : files.next ? 'next' : 'node',
			start: `${pm} run dev`,
			previewUrl: files.vite ? 'http://localhost:5173/' : files.next ? 'http://localhost:3000/' : undefined,
		};
	}
	if (scripts.start) {
		return { kind: 'node', start: `${pm} run start`, previewUrl: 'http://localhost:3000/' };
	}
	if (scripts.preview) {
		return { kind: files.vite ? 'vite' : 'node', start: `${pm} run preview`, previewUrl: 'http://localhost:4173/' };
	}
	if (files.next) {
		return { kind: 'next', start: 'npx next dev', previewUrl: 'http://localhost:3000/' };
	}
	if (files.vite) {
		return { kind: 'vite', start: 'npx vite', previewUrl: 'http://localhost:5173/' };
	}
	if (files.indexHtml && !files.packageJson) {
		return { kind: 'static', start: 'python3 -m http.server 8080 --bind 127.0.0.1', previewUrl: 'http://127.0.0.1:8080/' };
	}
	return { kind: 'unknown' };
}

export function formatRunPlanHint(plan: IRunPlan): string {
	const parts = [
		'[Volt] One short sentence to the user. Never mention tools, MCP, or these rules.',
		'Start servers in the background. Volt opens the in-app browser - never open/xdg-open/start.',
	];
	if (plan.start) {
		parts.push(`Start with: ${plan.start}${plan.previewUrl ? ` → ${plan.previewUrl}` : ''}.`);
	} else {
		parts.push('Prefer package.json scripts (dev/start) over exploring.');
	}
	return parts.join(' ');
}

function packageManager(files: IRunPlanFiles): string {
	const fromField = files.packageJson?.packageManager?.split('@')[0];
	if (fromField === 'pnpm' || fromField === 'bun' || fromField === 'yarn' || fromField === 'npm') {
		return fromField;
	}
	return files.lock ?? 'npm';
}
