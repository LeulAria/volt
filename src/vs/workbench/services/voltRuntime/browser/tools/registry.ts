/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { ISearchService } from '../../../search/common/search.js';
import { IVoltHostToolService } from '../../common/hostTools.js';
import { IVoltTool } from '../../common/tools/tool.js';
import { createBrowserTool } from './browserTool.js';
import { createFileTools } from './fileTools.js';
import { createGitTools } from './gitTools.js';
import { createMetaTools, IMetaToolHost } from './metaTools.js';
import { createSearchTools } from './searchTools.js';
import { createShellTool } from './shellTool.js';
import { createWebTools } from './webTools.js';

export interface IBuiltinToolServices {
	readonly fileService: IFileService;
	readonly searchService: ISearchService;
	readonly requestService: IRequestService;
	readonly stdio: IVoltStdioService;
	readonly hostTools: IVoltHostToolService;
	readonly root: () => URI | undefined;
	readonly meta: IMetaToolHost;
}

export function createBuiltinTools(services: IBuiltinToolServices): IVoltTool[] {
	return [
		...createFileTools(services.fileService, services.root),
		...createSearchTools(services.searchService, services.root),
		createShellTool(services.stdio, services.root),
		...createGitTools(services.stdio, services.root),
		...createWebTools(services.requestService),
		createBrowserTool(services.hostTools),
		...createMetaTools(services.meta),
	];
}
