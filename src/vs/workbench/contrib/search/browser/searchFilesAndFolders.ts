/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import * as glob from '../../../../base/common/glob.js';
import { ResourceSet } from '../../../../base/common/map.js';
import { relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { getExcludes, IFileQuery, ISearchComplete, ISearchConfiguration, ISearchService, QueryType } from '../../../services/search/common/search.js';

/**
 * Finds the files and folders in a workspace folder whose names match a pattern, the way a file
 * picker does: fuzzy (letters in order) or continuous, case insensitive, honouring search excludes.
 */
export async function searchFilesAndFolders(
	workspace: URI,
	pattern: string,
	fuzzyMatch: boolean,
	token: CancellationToken | undefined,
	cacheKey: string | undefined,
	configurationService: IConfigurationService,
	searchService: ISearchService
): Promise<{ folders: URI[]; files: URI[] }> {
	const segmentMatchPattern = caseInsensitiveGlobPattern(fuzzyMatch ? fuzzyMatchingGlobPattern(pattern) : continousMatchingGlobPattern(pattern));

	const searchExcludePattern = getExcludes(configurationService.getValue<ISearchConfiguration>({ resource: workspace })) || {};
	const searchOptions: IFileQuery = {
		folderQueries: [{
			folder: workspace,
			disregardIgnoreFiles: configurationService.getValue<boolean>('explorer.excludeGitIgnore'),
		}],
		type: QueryType.File,
		shouldGlobMatchFilePattern: true,
		cacheKey,
		excludePattern: searchExcludePattern,
		sortByScore: true,
	};

	let searchResult: ISearchComplete | undefined;
	try {
		searchResult = await searchService.fileSearch({ ...searchOptions, filePattern: `{**/${segmentMatchPattern}/**,${pattern}}` }, token);
	} catch (e) {
		if (!isCancellationError(e)) {
			throw e;
		}
	}

	if (!searchResult || token?.isCancellationRequested) {
		return { files: [], folders: [] };
	}

	const fileResources = searchResult.results.map(result => result.resource);
	const folderResources = getMatchingFoldersFromFiles(fileResources, workspace, segmentMatchPattern);

	return { folders: folderResources, files: fileResources };
}

function fuzzyMatchingGlobPattern(pattern: string): string {
	if (!pattern) {
		return '*';
	}
	return '*' + pattern.split('').join('*') + '*';
}

function continousMatchingGlobPattern(pattern: string): string {
	if (!pattern) {
		return '*';
	}
	return '*' + pattern + '*';
}

function caseInsensitiveGlobPattern(pattern: string): string {
	let caseInsensitiveFilePattern = '';
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (/[a-zA-Z]/.test(char)) {
			caseInsensitiveFilePattern += `[${char.toLowerCase()}${char.toUpperCase()}]`;
		} else {
			caseInsensitiveFilePattern += char;
		}
	}
	return caseInsensitiveFilePattern;
}

// TODO: remove this and have support from the search service
function getMatchingFoldersFromFiles(resources: URI[], workspace: URI, segmentMatchPattern: string): URI[] {
	const uniqueFolders = new ResourceSet();
	for (const resource of resources) {
		const relativePathToRoot = relativePath(workspace, resource);
		if (!relativePathToRoot) {
			throw new Error('Resource is not a child of the workspace');
		}

		let dirResource = workspace;
		const stats = relativePathToRoot.split('/').slice(0, -1);
		for (const stat of stats) {
			dirResource = dirResource.with({ path: `${dirResource.path}/${stat}` });
			uniqueFolders.add(dirResource);
		}
	}

	const matchingFolders: URI[] = [];
	for (const folderResource of uniqueFolders) {
		const stats = folderResource.path.split('/');
		const dirStat = stats[stats.length - 1];
		if (!dirStat || !glob.match(segmentMatchPattern, dirStat)) {
			continue;
		}

		matchingFolders.push(folderResource);
	}

	return matchingFolders;
}
