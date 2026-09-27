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
import { createBrowserTool } from './browserTool.js';
import { createCodeTools, ICodeIntelHost } from './codeTools.js';
import { createFileTools, IToolDocuments } from './fileTools.js';
import { createGitTools } from './gitTools.js';
import { createMetaTools, IMetaToolHost } from './metaTools.js';
import { createSearchTools } from './searchTools.js';
import { createShellTools } from './shellTool.js';
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
	readonly spillDir?: () => string | undefined;
	readonly onLog?: (path: string) => void;
}

/**
 * The fixed tool set, in a fixed order: the tool list is part of the cached prompt prefix, so
 * neither the order nor a description may change between requests of one conversation.
 */
export function createBuiltinTools(services: IBuiltinToolServices): IVoltTool[] {
	return [
		...createFileTools({
			fileService: services.fileService,
			root: services.root,
			readRoots: services.readRoots,
			ledger: services.ledger,
			documents: services.documents,
			rulesFor: services.rulesFor,
		}),
		...createSearchTools(services.searchService, services.root),
		...(services.codeIntel ? createCodeTools(services.codeIntel, services.root) : []),
		...createShellTools({ stdio: services.stdio, root: services.root, spillDir: services.spillDir, onLog: services.onLog }),
		...createGitTools(services.stdio, services.root),
		...createWebTools(services.requestService),
		createBrowserTool(services.hostTools),
		...createMetaTools(services.meta),
	];
}
