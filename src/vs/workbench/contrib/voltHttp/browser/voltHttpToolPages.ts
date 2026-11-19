/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IHttpExchange } from './voltHttpService.js';
import { HttpVariableLookup } from './voltHttpWidgets.js';

/**
 * The client's tools beside collections: automations (requests chained into an end-to-end flow),
 * performance tests (load on one request or connection) and security scans. Each is a file in the
 * project, listed in its own group of the client's sidebar and opened as a tab of the client.
 */
export type HttpToolKind = 'automation' | 'performance' | 'security';

export interface IHttpToolFileEntry {
	readonly uri: URI;
	readonly name: string;
	/** A short second line for the sidebar row: "6 steps", "50 connections, 30 s", "3 high, 2 medium". */
	readonly detail?: string;
	/** A run of it is in progress. */
	readonly running?: boolean;
}

/** What the sidebar and the tab strip need of a tool's service: its files in a project. */
export interface IHttpToolFiles {
	/** A file was added, removed, renamed or changed, or a run started or ended. */
	readonly onDidChange: Event<void>;
	/** The tool's files in `root` (the window's folders when undefined), by name. */
	list(root: URI | undefined): Promise<readonly IHttpToolFileEntry[]>;
	/** The name of a file already listed or loaded (the tab's label), without reading it. */
	nameOf(uri: URI): string | undefined;
	/** Writes a new file into the project's collections folder and returns it. */
	create(root: URI | undefined, name?: string): Promise<URI>;
	rename(uri: URI, name: string): Promise<void>;
	duplicate(uri: URI): Promise<URI>;
	remove(uri: URI): Promise<void>;
}

/** What an open tool tab keeps while another tab is in front. A run in progress lives in the tool's service, not here. */
export interface IHttpToolTabState {
	readonly uri: URI;
	/** The page's own memory (the tab picked, the row selected, scroll positions). */
	readonly memory: Record<string, unknown>;
}

export interface IHttpToolPageHost {
	readonly root: URI | undefined;
	readonly variables: HttpVariableLookup;
	/** The tab's label may have changed. */
	tabChanged(): void;
	/** Opens a collection's request in a tab of the client, with an exchange to show when given. */
	openRequest(collection: URI, id: string, exchange?: IHttpExchange): void;
	/** Puts a reference (a report, a finding, a flow) into the chat beside the client as a chip. */
	addToChat(label: string, value: string): void;
	/** Opens the file itself in an editor. */
	revealFile(uri: URI): void;
}

/**
 * A tool's page. Made with `instantiationService.createInstance(Page, parent, state, host)` each
 * time its tab comes in front and disposed when another does, so it must pick up a run that is
 * in progress or finished from its service.
 */
export interface IHttpToolPage extends IDisposable {
	layout(width: number, height: number): void;
}
