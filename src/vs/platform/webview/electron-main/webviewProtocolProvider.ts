/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { protocol } from 'electron';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { AppResourcePath, COI, FileAccess, Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../files/common/files.js';


export class WebviewProtocolProvider implements IDisposable {

	private static validWebviewFilePaths = new Map<string, { readonly mime: string }>([
		['/index.html', { mime: 'text/html' }],
		['/fake.html', { mime: 'text/html' }],
		['/service-worker.js', { mime: 'application/javascript' }],
	]);

	constructor(
		@IFileService private readonly _fileService: IFileService
	) {
		// Register the protocol for loading webview html
		const webviewHandler = this.handleWebviewRequest.bind(this);
		protocol.handle(Schemas.vscodeWebview, webviewHandler);
	}

	dispose(): void {
		protocol.unhandle(Schemas.vscodeWebview);
	}

	private async handleWebviewRequest(request: GlobalRequest): Promise<GlobalResponse> {
		try {
			const uri = URI.parse(request.url);
			const entry = WebviewProtocolProvider.validWebviewFilePaths.get(uri.path);
			if (entry) {
				const relativeResourcePath: AppResourcePath = `vs/workbench/contrib/webview/browser/pre${uri.path}`;
				const url = FileAccess.asFileUri(relativeResourcePath);

				const content = await this._fileService.readFile(url);
				// Exactly the file's bytes. A small file's Buffer is a slice of Node's shared pool, and
				// `.buffer` is the whole pool: fake.html then carried stale IPC and log bytes, and once an
				// agent page had passed through the pool its scripts ran in fake.html before the real
				// content was written over it (whose top-level `const`s then failed as redeclared).
				// (A Node Buffer's slice() is a view of the same pool, so copy into a new array.)
				const bytes = content.value.buffer;
				const exact = new Uint8Array(bytes.byteLength);
				exact.set(bytes);
				return new Response(exact.buffer, {
					headers: {
						'Content-Type': entry.mime,
						...COI.getHeadersFromQuery(request.url),
						'Cross-Origin-Resource-Policy': 'cross-origin',
					}
				});
			} else {
				return new Response(null, { status: 403 });
			}
		} catch {
			// noop
		}
		return new Response(null, { status: 500 });
	}
}
