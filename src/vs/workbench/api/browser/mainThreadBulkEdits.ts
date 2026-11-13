/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer, decodeBase64 } from '../../../base/common/buffer.js';
import { revive } from '../../../base/common/marshalling.js';
import { IBulkEditService, ResourceFileEdit, ResourceTextEdit } from '../../../editor/browser/services/bulkEditService.js';
import { WorkspaceEdit } from '../../../editor/common/languages.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceCellEditDto, IWorkspaceEditDto, IWorkspaceFileEditDto, MainContext, MainThreadBulkEditsShape } from '../common/extHost.protocol.js';
import { ResourceNotebookCellEdit } from '../../contrib/bulkEdit/browser/bulkCellEdits.js';
import { CellEditType } from '../../contrib/notebook/common/notebookCommon.js';
import { IExtHostContext, extHostNamedCustomer, VoltSandboxedHostError } from '../../services/extensions/common/extHostCustomers.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { executionBearingReason } from '../../../platform/voltSandbox/common/executionBearing.js';
import { isLinux } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { SerializableObjectWithBuffers } from '../../services/extensions/common/proxyIdentifier.js';


@extHostNamedCustomer(MainContext.MainThreadBulkEdits)
export class MainThreadBulkEdits implements MainThreadBulkEditsShape {

	constructor(
		private readonly _extHostContext: IExtHostContext,
		@IBulkEditService private readonly _bulkEditService: IBulkEditService,
		@ILogService private readonly _logService: ILogService,
		@IUriIdentityService private readonly _uriIdentService: IUriIdentityService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) { }

	dispose(): void { }

	$tryApplyWorkspaceEdit(dto: SerializableObjectWithBuffers<IWorkspaceEditDto>, undoRedoGroupId?: number, isRefactoring?: boolean): Promise<boolean> {
		const edits = reviveWorkspaceEditDto(dto.value, this._uriIdentService);
		if (this._extHostContext.voltSandboxed) {
			const refused = voltSandboxedEditRefusal(edits, this._workspaceContextService);
			if (refused) {
				this._logService.warn(`[volt-sandbox] a sandboxed extension's workspace edit was refused: ${refused}`);
				return Promise.reject(new VoltSandboxedHostError(`A workspace edit of ${refused}`));
			}
		}
		return this._bulkEditService.apply(edits, { undoRedoGroupId, respectAutoSaveConfig: isRefactoring }).then((res) => res.isApplied, err => {
			this._logService.warn(`IGNORING workspace edit: ${err}`);
			return false;
		});
	}
}

/**
 * Volt (P2): the window applies a sandboxed extension's edits outside its sandbox, so they stay in
 * the workspace (and untitled files), never in files that run code or are trusted later
 * (`.vscode/tasks.json`, `.git/hooks`, CI workflows). Returns the first resource refused.
 */
function voltSandboxedEditRefusal(edits: WorkspaceEdit, workspace: IWorkspaceContextService): string | undefined {
	const resources: URI[] = [];
	for (const edit of edits.edits) {
		if (ResourceTextEdit.is(edit) || ResourceNotebookCellEdit.is(edit)) {
			resources.push(edit.resource);
		} else if (ResourceFileEdit.is(edit)) {
			resources.push(...[edit.oldResource, edit.newResource].filter((uri): uri is URI => !!uri));
		}
	}
	for (const resource of resources) {
		if (resource.scheme === 'untitled' || resource.scheme === 'vscode-notebook-cell') {
			continue;
		}
		if (!workspace.getWorkspaceFolder(resource)) {
			return `${resource.toString()} (outside the workspace)`;
		}
		const why = executionBearingReason(resource.path, undefined, !isLinux);
		if (why) {
			return `${resource.toString()} (${why})`;
		}
	}
	return undefined;
}

export function reviveWorkspaceEditDto(data: IWorkspaceEditDto, uriIdentityService: IUriIdentityService, resolveDataTransferFile?: (id: string) => Promise<VSBuffer>): WorkspaceEdit;
export function reviveWorkspaceEditDto(data: IWorkspaceEditDto | undefined, uriIdentityService: IUriIdentityService, resolveDataTransferFile?: (id: string) => Promise<VSBuffer>): WorkspaceEdit | undefined;
export function reviveWorkspaceEditDto(data: IWorkspaceEditDto | undefined, uriIdentityService: IUriIdentityService, resolveDataTransferFile?: (id: string) => Promise<VSBuffer>): WorkspaceEdit | undefined {
	if (!data || !data.edits) {
		return <WorkspaceEdit>data;
	}
	const result = revive<WorkspaceEdit>(data);
	for (const edit of result.edits) {
		if (ResourceTextEdit.is(edit)) {
			edit.resource = uriIdentityService.asCanonicalUri(edit.resource);
		}
		if (ResourceFileEdit.is(edit)) {
			if (edit.options) {
				const inContents = (edit as IWorkspaceFileEditDto).options?.contents;
				if (inContents) {
					if (inContents.type === 'base64') {
						edit.options.contents = Promise.resolve(decodeBase64(inContents.value));
					} else {
						if (resolveDataTransferFile) {
							edit.options.contents = resolveDataTransferFile(inContents.id);
						} else {
							throw new Error('Could not revive data transfer file');
						}
					}
				}
			}
			edit.newResource = edit.newResource && uriIdentityService.asCanonicalUri(edit.newResource);
			edit.oldResource = edit.oldResource && uriIdentityService.asCanonicalUri(edit.oldResource);
		}
		if (ResourceNotebookCellEdit.is(edit)) {
			edit.resource = uriIdentityService.asCanonicalUri(edit.resource);
			const cellEdit = (edit as IWorkspaceCellEditDto).cellEdit;
			if (cellEdit.editType === CellEditType.Replace) {
				edit.cellEdit = {
					...cellEdit,
					cells: cellEdit.cells.map(cell => ({
						...cell,
						outputs: cell.outputs.map(output => ({
							...output,
							outputs: output.items.map(item => {
								return {
									mime: item.mime,
									data: item.valueBytes
								};
							})
						}))
					}))
				};
			}
		}
	}
	return <WorkspaceEdit>data;
}
