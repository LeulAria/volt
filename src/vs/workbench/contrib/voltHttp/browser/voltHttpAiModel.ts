/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgentOrchestratorService } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { onDidChangeShownAgentChat, shownAgentChat } from '../../voltAgent/browser/editor/agentShownChat.js';
import { AgentModelPicker } from '../../voltAgent/browser/picker/agentModelPicker.js';

/**
 * The model every AI feature of Volt Client uses (Edit with AI, Generate tests, Write with AI,
 * flow generation, analysis, triage). It is the model of the chat in front, so the client answers
 * with the model the user is talking to. A model picked in the client holds while that chat stays
 * in front on the same model; switching chats, or the chat's model, follows the chat again.
 */
let picked: { readonly ref: string; readonly chat: string | undefined; readonly chatModel: string | undefined } | undefined;

interface IModelServices {
	readonly runtime: IAgentRuntimeService;
	readonly orchestrator: IAgentOrchestratorService;
}

function services(instantiationService: IInstantiationService): IModelServices {
	return instantiationService.invokeFunction(accessor => ({ runtime: accessor.get(IAgentRuntimeService), orchestrator: accessor.get(IAgentOrchestratorService) }));
}

/** The model of the chat in front: its own stored model, else what its composer shows. */
function chatModelRef({ runtime, orchestrator }: IModelServices): string | undefined {
	const chat = shownAgentChat();
	const usable = (ref: string | undefined) => ref && runtime.resolveCatalogItem(ref)?.enabled ? ref : undefined;
	return usable(chat ? orchestrator.getThread(chat)?.modelRef : undefined) ?? usable(runtime.getActiveCatalogRef());
}

function pickedRef(all: IModelServices): string | undefined {
	if (!picked) {
		return undefined;
	}
	if (picked.chat !== shownAgentChat() || picked.chatModel !== chatModelRef(all) || !all.runtime.resolveCatalogItem(picked.ref)?.enabled) {
		picked = undefined;
		return undefined;
	}
	return picked.ref;
}

/** The model a Volt Client AI feature runs on: the one picked here, else the chat's, else the first one set up. */
export function httpAiModelRef(instantiationService: IInstantiationService): string | undefined {
	const all = services(instantiationService);
	return pickedRef(all) ?? chatModelRef(all) ?? all.runtime.listCatalog().find(item => item.enabled)?.ref;
}

/** The button that shows that model and picks another. `title` says what the model does here. */
export function createHttpAiModelButton(parent: HTMLElement, instantiationService: IInstantiationService, store: DisposableStore, title: string, alignment = AnchorAlignment.LEFT): HTMLButtonElement {
	const all = services(instantiationService);
	const button = append(parent, $('button.volt-agent-model.volt-http-ai-model')) as HTMLButtonElement;
	button.type = 'button';
	button.setAttribute('aria-haspopup', 'dialog');
	button.title = title;
	const picker = store.add(instantiationService.createInstance(AgentModelPicker, {
		binding: {
			get: () => pickedRef(all),
			set: ref => {
				picked = ref ? { ref, chat: shownAgentChat(), chatModel: chatModelRef(all) } : undefined;
			},
			autoLabel: localize('voltHttp.aiAuto', "Chat model"),
			autoDescription: localize('voltHttp.aiAutoDesc', "The model of the chat in front"),
			autoRef: () => chatModelRef(all),
		},
		position: AnchorPosition.BELOW,
		alignment,
		onDidChange: () => paint(),
	}));
	let shown: string | undefined;
	const paint = () => {
		shown = `${pickedRef(all)}\n${chatModelRef(all)}`;
		picker.syncCatalog();
		button.replaceChildren();
		picker.renderTrigger(button);
		button.appendChild(renderIcon(Codicon.chevronDown));
	};
	// The chat in front changed, or its model did: follow it (and nothing else repaints the button).
	const follow = () => {
		if (shown !== `${pickedRef(all)}\n${chatModelRef(all)}`) {
			paint();
		}
	};
	paint();
	store.add(onDidChangeShownAgentChat(follow));
	store.add(all.orchestrator.onDidChange(follow));
	store.add(addDisposableListener(button, EventType.CLICK, () => picker.show(button, () => paint())));
	return button;
}
