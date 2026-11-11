/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { ISearchService } from '../../../search/common/search.js';
import { FileLedger } from '../../common/harness/fileLedger.js';
import { IVoltHostToolService } from '../../common/hostTools.js';
import { IVoltTool } from '../../common/tools/tool.js';
import { createBrowserTools } from './browserTool.js';
import { createCodeIndexNav } from './codeIndexNav.js';
import { createCodeTools, ICodeIntelHost } from './codeTools.js';
import { withEditDiagnostics } from './editDiagnostics.js';
import { createFileTools, IFileToolHost, IToolDocuments, writeComputedEdit } from './fileTools.js';
import { createGitTools } from './gitTools.js';
import { createIdeTools } from './ideTools.js';
import { createMetaTools, IMetaToolHost } from './metaTools.js';
import { VoltSearch } from '../search/voltSearch.js';
import { createSearchTools, ISearchIndex } from './searchTools.js';
import { createShellTools } from './shellTool.js';
import { createTerminalTools } from './terminalTool.js';
import { createWebTools } from './webTools.js';

export interface IBuiltinToolServices {
	readonly fileService: IFileService;
	readonly searchService: ISearchService;
	readonly requestService: IRequestService;
	readonly stdio: IVoltStdioService;
	readonly hostTools: IVoltHostToolService;
	readonly root: () => URI | undefined;
	readonly meta: IMetaToolHost;
	readonly ledger?: () => FileLedger | undefined;
	readonly documents?: IToolDocuments;
	readonly readRoots?: () => readonly URI[];
	readonly rulesFor?: (uri: URI) => string | undefined;
	readonly codeIntel?: ICodeIntelHost;
	/** Volt's unified search: the code index, FFF and ripgrep behind one API. */
	readonly search: VoltSearch;
	/** Volt's code index, for code_nav when language servers cannot answer. */
	readonly codeIndex?: ISearchIndex;
	/** Run shell commands through RTK when it is installed (Settings > Code Intelligence). */
	readonly rtk?: () => boolean;
	readonly rtkExclusions?: () => readonly string[];
	readonly spillDir?: () => string | undefined;
	readonly onLog?: (path: string) => void;
}

/**
 * The fixed tool set, in a fixed order: the tool list is part of the cached prompt prefix, so
 * neither the order nor a description may change between requests of one conversation.
 */
export function createBuiltinTools(services: IBuiltinToolServices): IVoltTool[] {
	const files: IFileToolHost = {
		fileService: services.fileService,
		root: services.root,
		readRoots: services.readRoots,
		ledger: services.ledger,
		documents: services.documents,
		rulesFor: services.rulesFor,
	};
	const codeIntel = services.codeIntel;
	return [
		// With language servers, writes answer with the file's errors (no extra diagnostics turn).
		...createFileTools(files).map(tool => codeIntel && (tool.name === 'edit_file' || tool.name === 'write_file') ? withEditDiagnostics(tool, codeIntel, services.root) : tool),
		...createSearchTools(services.search, services.root),
		...(services.codeIntel ? createCodeTools(
			services.codeIntel,
			services.root,
			services.codeIndex ? createCodeIndexNav(services.codeIndex) : undefined,
			// Language server edits are written like edit_file's: open buffers, ledger, change set.
			(change, ctx) => writeComputedEdit(files, change.uri, change.before, change.after, ctx),
		) : []),
		...createShellTools({ stdio: services.stdio, root: services.root, spillDir: services.spillDir, onLog: services.onLog, hostTools: services.hostTools, rtk: services.rtk, rtkExclusions: services.rtkExclusions }),
		...createTerminalTools(services.hostTools),
		...createIdeTools(services.hostTools),
		...createGitTools(services.stdio, services.root),
		...createWebTools(services.requestService),
		...createBrowserTools(services.hostTools),
		...createMetaTools(services.meta),
	];
}
