/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { COPY_PATH_COMMAND_ID } from '../../../files/browser/fileConstants.js';
import { MultiDiffEditor } from '../../../multiDiffEditor/browser/multiDiffEditor.js';
import { AGENT_CHANGES_EDITOR_ID, AgentChangesEditorInput } from './agentChangesEditor.js';
import { IAgentSessionChangesService } from './agentSessionChangesService.js';

const AGENT_CHANGE_FILE = ContextKeyExpr.equals('voltAgentChangesFile', true);
const AGENT_CHANGE_ADDED = ContextKeyExpr.equals('voltAgentChangeKind', 'added');
const IN_CHANGES_REVIEW = ContextKeyExpr.or(
	ContextKeyExpr.equals('activeEditor', AGENT_CHANGES_EDITOR_ID),
	ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID),
);

function resolveFileUri(uri: URI | undefined): URI | undefined {
	if (!uri) {
		return undefined;
	}
	return uri.scheme === Schemas.voltAgentSnapshot ? URI.file(uri.path) : uri;
}

function sessionIdFrom(accessor: ServicesAccessor, resource?: URI): string | undefined {
	if (resource?.scheme === Schemas.voltAgentSnapshot) {
		const session = new URLSearchParams(resource.query).get('session');
		if (session) {
			return decodeURIComponent(session);
		}
	}
	const input = accessor.get(IEditorService).activeEditor;
	return input instanceof AgentChangesEditorInput ? input.sessionId : undefined;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.agent.changes.copyPath',
			title: localize2('voltAgent.copyPath', 'Copy Path'),
			icon: Codicon.copy,
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: ContextKeyExpr.or(AGENT_CHANGE_FILE, IN_CHANGES_REVIEW),
				group: 'navigation',
				order: 20,
			},
		});
	}

	override async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		const uri = resolveFileUri(resource);
		if (!uri) {
			return;
		}
		await accessor.get(ICommandService).executeCommand(COPY_PATH_COMMAND_ID, uri);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.agent.changes.discard',
			title: localize2('voltAgent.discardChanges', 'Discard Changes'),
			icon: Codicon.discard,
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: AGENT_CHANGE_FILE,
				group: 'navigation',
				order: 21,
			},
		});
	}

	override async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		if (!resource) {
			return;
		}
		const sessionId = sessionIdFrom(accessor, resource);
		if (!sessionId) {
			return;
		}
		await accessor.get(IAgentSessionChangesService).discardFile(sessionId, resource);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.agent.changes.newBadge',
			title: localize2('voltAgent.changeNew', 'New'),
			f1: false,
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: ContextKeyExpr.and(AGENT_CHANGE_FILE, AGENT_CHANGE_ADDED),
				group: 'navigation',
				order: 1,
			},
		});
	}

	override async run(): Promise<void> { }
});
