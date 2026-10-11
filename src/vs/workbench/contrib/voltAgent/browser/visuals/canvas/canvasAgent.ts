/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../../../base/browser/dom.js';
import { Event } from '../../../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { setPageContext } from '../agentVisualBridge.js';
import { IVoltCanvasService } from './canvasService.js';

/** A chat shown in the canvas's sidebar: its own model picker, composer and live transcript. */
export interface ICanvasAgentChat extends IDisposable {
	readonly element: HTMLElement;
	/** The user sent a message from its composer. */
	readonly onDidSend: Event<void>;
	layout(width: number, height: number): void;
	/** Sends now (queued behind a running turn). */
	submit(text: string): void;
	/** Puts the text in its composer for the user to finish. */
	draft(text: string): void;
}

/** Opens chat `sessionId` (a side chat of `parentChat`, in its project). */
export type CanvasAgentChatFactory = (instantiationService: IInstantiationService, sessionId: string, parentChat: string | undefined) => Promise<ICanvasAgentChat>;

let chatFactory: CanvasAgentChatFactory | undefined;

/** The chat editor provides the chat (it imports the visuals, so the visuals cannot import it). */
export function setCanvasAgentChatFactory(factory: CanvasAgentChatFactory): IDisposable {
	chatFactory = factory;
	return toDisposable(() => {
		if (chatFactory === factory) {
			chatFactory = undefined;
		}
	});
}

interface ISlot {
	readonly element: HTMLElement;
	readonly observer: ResizeObserver;
}

interface IAgentEntry {
	readonly slots: ISlot[];
	readonly store: DisposableStore;
	chat?: ICanvasAgentChat;
}

/** One agent per canvas, however many views show it: the newest view holds it, the others get it back. */
const entries = new Map<string, IAgentEntry>();

/**
 * Shows canvas `canvasId`'s agent in `slot` until the result is disposed. The first view to ask opens
 * its chat; every prompt about the canvas goes to it from then on (IVoltCanvasService.registerAgent).
 */
export function attachCanvasAgent(instantiationService: IInstantiationService, canvasId: string, slot: HTMLElement): IDisposable {
	let entry = entries.get(canvasId);
	const created = !entry;
	if (!entry) {
		entry = { slots: [], store: new DisposableStore() };
		entries.set(canvasId, entry);
	}
	const current = entry;
	const observer = new (getWindow(slot).ResizeObserver)(() => {
		if (current.slots[current.slots.length - 1]?.element === slot) {
			current.chat?.layout(slot.clientWidth, slot.clientHeight);
		}
	});
	observer.observe(slot);
	const own: ISlot = { element: slot, observer };
	current.slots.push(own);
	if (created) {
		void open(instantiationService, canvasId, current);
	} else {
		mountTop(current);
	}
	return toDisposable(() => {
		observer.disconnect();
		const index = current.slots.indexOf(own);
		if (index >= 0) {
			current.slots.splice(index, 1);
		}
		if (current.slots.length) {
			mountTop(current);
			return;
		}
		entries.delete(canvasId);
		current.store.dispose();
	});
}

function mountTop(entry: IAgentEntry): void {
	const slot = entry.slots[entry.slots.length - 1];
	const chat = entry.chat;
	if (!slot || !chat) {
		return;
	}
	if (chat.element.parentElement !== slot.element) {
		slot.element.replaceChildren(chat.element);
	}
	chat.layout(slot.element.clientWidth, slot.element.clientHeight);
}

async function open(instantiationService: IInstantiationService, canvasId: string, entry: IAgentEntry): Promise<void> {
	const [canvas, logService] = instantiationService.invokeFunction(accessor => [accessor.get(IVoltCanvasService), accessor.get(ILogService)] as const);
	const factory = chatFactory;
	try {
		const doc = await canvas.get(canvasId);
		if (!doc || !factory) {
			return;
		}
		const sessionId = await canvas.ensureAgentChat(canvasId);
		const chat = await factory(instantiationService, sessionId, doc.chat);
		if (entry.store.isDisposed) {
			chat.dispose();
			return;
		}
		entry.store.add(chat);
		entry.chat = chat;
		// What this chat is for rides along with its next message (each time: the user may type anything).
		const brief = () => void canvas.get(canvasId).then(latest => latest && setPageContext(sessionId, `canvas:${canvasId}`, latest.title, JSON.stringify({
			canvas: latest.id,
			title: latest.title,
			version: latest.version,
			frames: latest.frames.map(frame => ({ id: frame.id, name: frame.name, kind: frame.kind })),
			openComments: latest.comments.filter(comment => comment.status === 'open').length,
			note: `This chat is the design canvas "${latest.title}"'s own agent: the user sees the canvas beside it. Change it in place with canvas_update {"canvas": "${latest.id}", ...} (edits for small changes), read it with canvas_read, and never make a new canvas for a change. Keep replies to a line or two.`,
		})));
		brief();
		entry.store.add(chat.onDidSend(() => brief()));
		entry.store.add(canvas.registerAgent(canvasId, {
			sessionId,
			prompt: (text, send) => {
				brief();
				if (send) {
					chat.submit(text);
				} else {
					chat.draft(text);
				}
			},
		}));
		mountTop(entry);
	} catch (err) {
		logService.warn(`[volt canvas] could not open the agent of ${canvasId}`, err);
	}
}
