/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ISearchModel } from './searchTreeCommon.js';

export const ISearchViewModelWorkbenchService = createDecorator<ISearchViewModelWorkbenchService>('searchViewModelWorkbenchService');

export interface ISearchViewModelWorkbenchService {
	readonly _serviceBrand: undefined;

	searchModel: ISearchModel;

	/** The folder the Search view searches instead of the workspace's folders (it need not be one of them). */
	readonly scopedFolder: URI | undefined;
	readonly onDidChangeScopedFolder: Event<void>;
	/** Searches look in `folder` until the returned disposable is disposed or another scope replaces it. */
	scopeToFolder(folder: URI): IDisposable;
}
