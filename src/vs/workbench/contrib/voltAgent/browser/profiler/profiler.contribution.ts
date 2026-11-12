/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { AgentEditor } from '../editor/agentEditor.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { VoltProfilerEditor } from './profilerEditor.js';
import { PROFILER_EDITOR_ID, VoltProfilerInput, VoltProfilerInputSerializer } from './profilerInput.js';
import { ADD_PROFILE_TO_CHAT_COMMAND_ID, IVoltProfilerService, OPEN_PROFILER_COMMAND_ID } from './voltProfilerService.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VoltProfilerEditor, PROFILER_EDITOR_ID, localize('voltProfiler.editorLabel', "Profiler")),
	[new SyncDescriptor(VoltProfilerInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(VoltProfilerInput.TypeID, VoltProfilerInputSerializer);

/** Files the Profiler reads: V8 CPU and heap profiles, speedscope, Chrome traces, folded stacks, Volt's own. */
const PROFILE_FILE = ContextKeyExpr.regex('resourceFilename', /\.(cpuprofile|heapprofile|folded|collapsed)$|\.(speedscope|voltprofile)\.json$|^trace.*\.json$|\.trace\.json$/i);

function toUri(value: unknown): URI | undefined {
	return URI.isUri(value) ? value : typeof value === 'string' && value ? (value.includes('://') ? URI.parse(value) : URI.file(value)) : undefined;
}

registerAction2(class OpenInProfilerAction extends Action2 {
	constructor() {
		super({
			id: OPEN_PROFILER_COMMAND_ID,
			title: localize2('voltProfiler.open', "Open in Profiler"),
			category: localize2('voltProfiler.category', "Profiler"),
			icon: Codicon.flame,
			f1: true,
			menu: [
				{ id: MenuId.ExplorerContext, group: 'navigation', order: 30, when: PROFILE_FILE },
				{ id: MenuId.EditorTitleContext, group: '1_open', order: 30, when: PROFILE_FILE },
			],
		});
	}

	override async run(accessor: ServicesAccessor, uri?: unknown, compareWith?: unknown): Promise<void> {
		const profiler = accessor.get(IVoltProfilerService);
		const notifications = accessor.get(INotificationService);
		const file = toUri(uri) ?? accessor.get(IEditorService).activeEditor?.resource;
		if (!file) {
			notifications.info(localize('voltProfiler.noFile', "Open a profile file (.cpuprofile, .heapprofile, speedscope, trace or folded stacks) first."));
			return;
		}
		try {
			const root = accessor.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri.fsPath;
			const base = toUri(compareWith);
			const loaded = await profiler.load(file, { ...(base ? { compareWith: base } : {}), ...(root ? { root } : {}) });
			await profiler.reveal(loaded.id);
		} catch (err) {
			notifications.error(localize('voltProfiler.openFailed', "The Profiler could not read {0}: {1}", file.fsPath, err instanceof Error ? err.message : String(err)));
		}
	}
});

registerAction2(class AddProfileToChatAction extends Action2 {
	constructor() {
		super({ id: ADD_PROFILE_TO_CHAT_COMMAND_ID, title: localize2('voltProfiler.addToChat', "Add Profile to Chat") });
	}

	override async run(accessor: ServicesAccessor, args?: { readonly label?: string; readonly value?: string; readonly chatId?: string }): Promise<void> {
		if (!args?.label || !args.value) {
			return;
		}
		// The profile's own chat when it is on screen, else any chat on screen.
		const groups = accessor.get(IEditorGroupsService);
		const chats: AgentEditor[] = [];
		for (const part of groups.parts.length ? groups.parts : [groups.mainPart]) {
			for (const group of part.groups) {
				const pane = group.activeEditorPane;
				if (pane instanceof AgentEditor) {
					chats.push(pane);
				}
			}
		}
		const own = chats.find(pane => pane.input instanceof AgentEditorInput && pane.input.sessionId === args.chatId);
		for (const chat of own ? [own, ...chats.filter(pane => pane !== own)] : chats) {
			if (chat.addContextMention(args.label, args.value)) {
				return;
			}
		}
		await accessor.get(IClipboardService).writeText(args.value);
		accessor.get(INotificationService).info(localize('voltProfiler.copied', "No chat is open beside the Profiler, so the selection was copied. Paste it into a chat."));
	}
});
