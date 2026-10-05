/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { COPY_PATH_COMMAND_ID } from '../../../files/browser/fileConstants.js';
import { MultiDiffEditor } from '../../../multiDiffEditor/browser/multiDiffEditor.js';
import { MultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { AGENT_CHANGES_EDITOR_ID, AgentChangesEditorInput } from './agentChangesEditor.js';
import { IAgentSessionChangesService, parseAgentChangesSourceUri } from './agentSessionChangesService.js';
import { fileUriFromBaseline, IAgentEditsService, sessionFromBaseline } from './agentEditsService.js';
import {
	AgentTurnRef,
	CHECKPOINT_BEGIN_TURN_COMMAND_ID,
	CHECKPOINT_HAS_CHANGES_COMMAND_ID,
	CHECKPOINT_PREVIEW_COMMAND_ID,
	CHECKPOINT_REDO_COMMAND_ID,
	CHECKPOINT_RESTORE_COMMAND_ID,
	IAgentCheckpointService,
	IAgentRestorePreview,
	IAgentRestoreResult,
} from './agentCheckpointService.js';

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
	if (input instanceof MultiDiffEditorInput && input.resource) {
		// A scope of a chat's changes opened as a diff (Review, Agent Turns).
		return parseAgentChangesSourceUri(input.resource)?.sessionId;
	}
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

const PENDING_FILE = ContextKeyExpr.equals('voltAgentPendingFile', true);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.agent.changes.undoPendingFile',
			title: localize2('voltAgent.undoFile', 'Undo File'),
			icon: Codicon.close,
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: PENDING_FILE,
				group: 'navigation',
				order: 30,
			},
		});
	}

	override async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		if (resource) {
			await accessor.get(IAgentEditsService).undoFile(fileUriFromBaseline(resource) ?? resource, sessionFromBaseline(resource) ?? sessionIdFrom(accessor, resource));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.agent.changes.keepPendingFile',
			title: localize2('voltAgent.keepFile', 'Keep File'),
			icon: Codicon.check,
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: PENDING_FILE,
				group: 'navigation',
				order: 31,
			},
		});
	}

	override async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		if (resource) {
			await accessor.get(IAgentEditsService).keepFile(fileUriFromBaseline(resource) ?? resource, sessionFromBaseline(resource) ?? sessionIdFrom(accessor, resource));
		}
	}
});

// --- Checkpoints. The transcript calls these through ICommandService (see IMPLEMENTATION-LOG, WP3 exports).

interface ICheckpointArgs {
	readonly sessionId: string;
	/** The user message's turn id (`IAgentUserMessage.id`). */
	readonly turnId?: string;
	/** 0-based index of that user message; used when no checkpoint carries `turnId`. */
	readonly userTurn?: number;
}

/** The checkpoint for `args`: by turn id when one carries it, else by user-message index. */
async function turnRef(checkpoints: IAgentCheckpointService, args: ICheckpointArgs | undefined): Promise<AgentTurnRef | undefined> {
	if (!args?.sessionId) {
		return undefined;
	}
	const loaded = await checkpoints.loadCheckpoints(args.sessionId);
	if (args.turnId && loaded.some(checkpoint => checkpoint.turnId === args.turnId)) {
		return args.turnId;
	}
	return typeof args.userTurn === 'number' ? args.userTurn : args.turnId;
}

/** `{ sessionId, turnId }` → void. Call right before sending the prompt with that turn id: the checkpoint then predates the agent. */
CommandsRegistry.registerCommand(CHECKPOINT_BEGIN_TURN_COMMAND_ID, async (accessor, args: ICheckpointArgs | undefined) => {
	if (args?.sessionId && args.turnId) {
		await accessor.get(IAgentCheckpointService).beginTurn(args.sessionId, args.turnId);
	}
});

/** `{ sessionId, turnId?, userTurn? }` → IAgentRestorePreview | undefined: what a restore would change. */
CommandsRegistry.registerCommand(CHECKPOINT_PREVIEW_COMMAND_ID, async (accessor, args: ICheckpointArgs | undefined): Promise<IAgentRestorePreview | undefined> => {
	const checkpoints = accessor.get(IAgentCheckpointService);
	const ref = await turnRef(checkpoints, args);
	return ref === undefined ? undefined : checkpoints.previewRestore(args!.sessionId, ref);
});

/** `{ sessionId, turnId?, userTurn? }` → boolean: files differ from how they were before that message. */
CommandsRegistry.registerCommand(CHECKPOINT_HAS_CHANGES_COMMAND_ID, async (accessor, args: ICheckpointArgs | undefined): Promise<boolean> => {
	const checkpoints = accessor.get(IAgentCheckpointService);
	const ref = await turnRef(checkpoints, args);
	const preview = ref === undefined ? undefined : await checkpoints.previewRestore(args!.sessionId, ref).catch(() => undefined);
	return !!preview?.files.some(file => file.action !== 'none');
});

/**
 * `{ sessionId, turnId?, userTurn? }` → boolean. Puts the files back as they were before that
 * message (shell side effects included). The caller confirms first; this only asks when files
 * were edited after the agent and those edits overlap.
 */
CommandsRegistry.registerCommand(CHECKPOINT_RESTORE_COMMAND_ID, async (accessor, args: ICheckpointArgs | undefined): Promise<boolean> => {
	const checkpoints = accessor.get(IAgentCheckpointService);
	const dialogs = accessor.get(IDialogService);
	const notifications = accessor.get(INotificationService);
	const ref = await turnRef(checkpoints, args);
	try {
		const preview = ref === undefined ? undefined : await checkpoints.previewRestore(args!.sessionId, ref);
		if (!preview) {
			notifications.info(localize('voltAgent.checkpoint.none', "There is no checkpoint for this message. Checkpoints need the project to be a folder on this computer."));
			return false;
		}
		const overwrite = await askOverwrite(dialogs, preview);
		if (overwrite === undefined) {
			return false;
		}
		const result = await checkpoints.restoreCheckpoint(args!.sessionId, ref!, { overwrite });
		reportRestore(notifications, result, localize('voltAgent.checkpoint.restored', "Restored {0} files to how they were before this message.", changedCount(result)));
		return !!result?.applied;
	} catch (err) {
		notifications.error(localize('voltAgent.checkpoint.failed', "Could not restore the checkpoint: {0}", toErrorMessage(err)));
		return false;
	}
});

/** `{ sessionId }` → boolean. Undoes the chat's latest restore ("Redo checkpoint"). */
CommandsRegistry.registerCommand(CHECKPOINT_REDO_COMMAND_ID, async (accessor, args: { readonly sessionId: string } | undefined): Promise<boolean> => {
	const checkpoints = accessor.get(IAgentCheckpointService);
	const dialogs = accessor.get(IDialogService);
	const notifications = accessor.get(INotificationService);
	if (!args?.sessionId || !checkpoints.canRedo(args.sessionId)) {
		return false;
	}
	try {
		let result = await checkpoints.redo(args.sessionId);
		if (result?.conflicts.length) {
			const { confirmed } = await dialogs.confirm({
				type: 'warning',
				message: localize('voltAgent.checkpoint.redoConflict', "{0} changed since the checkpoint was restored.", conflictNames(result)),
				detail: localize('voltAgent.checkpoint.redoConflictDetail', "The other files are back. Overwrite these with the latest checkpoint too? Your edits in them will be lost."),
				primaryButton: localize({ key: 'voltAgent.checkpoint.overwrite', comment: ['&& denotes a mnemonic'] }, "&&Overwrite"),
			});
			if (confirmed) {
				result = await checkpoints.redo(args.sessionId, { overwrite: true });
			}
		}
		reportRestore(notifications, result, localize('voltAgent.checkpoint.redone', "Brought back {0} files from the latest checkpoint.", changedCount(result)));
		return !!result?.applied;
	} catch (err) {
		notifications.error(localize('voltAgent.checkpoint.redoFailed', "Could not redo the checkpoint: {0}", toErrorMessage(err)));
		return false;
	}
});

/** undefined: cancelled. Otherwise whether to overwrite files edited after the agent. */
async function askOverwrite(dialogs: IDialogService, preview: IAgentRestorePreview): Promise<boolean | undefined> {
	if (!preview.conflicts.length) {
		return false;
	}
	const { result } = await dialogs.prompt<boolean | undefined>({
		type: Severity.Warning,
		message: localize('voltAgent.checkpoint.conflict', "{0} changed after the agent edited it.", conflictNames(preview)),
		detail: localize('voltAgent.checkpoint.conflictDetail', "Those edits overlap the agent's. Keep them (those files stay as they are), or overwrite them with the checkpoint."),
		buttons: [
			{ label: localize({ key: 'voltAgent.checkpoint.keepEdits', comment: ['&& denotes a mnemonic'] }, "&&Keep My Edits"), run: () => false },
			{ label: localize({ key: 'voltAgent.checkpoint.overwriteEdits', comment: ['&& denotes a mnemonic'] }, "&&Overwrite"), run: () => true },
		],
		cancelButton: { run: () => undefined },
	});
	return result;
}

function conflictNames(preview: IAgentRestorePreview): string {
	const names = preview.conflicts.map(file => basename(file.uri));
	return names.length <= 3 ? names.join(', ') : localize('voltAgent.checkpoint.conflictMany', "{0} and {1} more", names.slice(0, 2).join(', '), names.length - 2);
}

function changedCount(result: IAgentRestoreResult | undefined): number {
	return result?.files.filter(file => file.action !== 'none').length ?? 0;
}

function reportRestore(notifications: INotificationService, result: IAgentRestoreResult | undefined, message: string): void {
	if (!result?.applied) {
		return;
	}
	const skipped = result.conflicts.length;
	notifications.info(skipped
		? `${message} ${localize('voltAgent.checkpoint.skipped', "Left {0} with your edits as they were.", conflictNames(result))}`
		: message);
}
