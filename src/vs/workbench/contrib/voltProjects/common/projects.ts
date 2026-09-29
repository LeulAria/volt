/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export type VoltProjectState =
	| { readonly kind: 'ready' }
	| { readonly kind: 'cloning'; readonly jobId: string; readonly percent: number; readonly message?: string }
	| { readonly kind: 'error'; readonly message: string; readonly jobId?: string };

export type VoltProjectSource = 'local' | 'git' | 'github';

export interface IVoltProject {
	/** Same id as the session-context project record. */
	readonly id: string;
	readonly uri: URI;
	readonly name: string;
	readonly source: VoltProjectSource;
	readonly remoteUrl?: string;
	readonly state: VoltProjectState;
}

export const IVoltProjectsService = createDecorator<IVoltProjectsService>('voltProjectsService');

/**
 * Every project Volt knows, shared by the home pane, the agent tab's Project menu and Add
 * Project. Backed by the session-context project registry; adds where a project came from and
 * its clone state.
 */
export interface IVoltProjectsService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	list(): readonly IVoltProject[];
	get(id: string): IVoltProject | undefined;
	getByUri(uri: URI): IVoltProject | undefined;
	/** Registers the folder (or returns the existing project for it). */
	add(uri: URI, options?: { readonly name?: string; readonly source?: VoltProjectSource; readonly remoteUrl?: string }): IVoltProject;
	/** Forgets the project. Its folder stays on disk. */
	remove(id: string): void;
	setState(id: string, state: VoltProjectState): void;
	/** Resolves true once the project's files are there, false if its clone failed or was cancelled. */
	whenReady(id: string): Promise<boolean>;
	/** Makes it the active project and opens a new agent tab in it. */
	open(id: string): Promise<void>;
}

/** Command ids, so the agent UI can open Add Project without importing its UI. */
export const VoltProjectCommands = {
	/** Args: `{ anchor?: HTMLElement; current?: URI }`. Shows the project menu under `anchor`, or the Add Project dialog when there is none. */
	addProject: 'volt.projects.add',
	openFromThisPC: 'volt.projects.openFromThisPC',
	cloneFromUrl: 'volt.projects.cloneFromUrl',
	cloneFromGitHub: 'volt.projects.cloneFromGitHub',
	cancelClone: 'volt.projects.cancelClone',
	retryClone: 'volt.projects.retryClone',
} as const;
