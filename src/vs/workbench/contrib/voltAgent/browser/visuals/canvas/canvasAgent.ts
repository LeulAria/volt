/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';

/**
 * The canvas tab's chat island (canvasAgentChat.ts): the canvas's chat at the bottom of the board,
 * the way Scratch docks its agents. Prompts from the page go to it while it holds that chat.
 */
export interface ICanvasChatIsland extends IDisposable {
	/** The tab is on screen (or not): the chat is only held while it is. */
	setVisible(visible: boolean): void;
}

/** Puts canvas `canvasId`'s island in `parent` (the view's host, over the page). */
export type CanvasChatIslandFactory = (instantiationService: IInstantiationService, parent: HTMLElement, canvasId: string) => ICanvasChatIsland;

let islandFactory: CanvasChatIslandFactory | undefined;

/** The chat editor provides the island (it imports the visuals, so the visuals cannot import it). */
export function setCanvasChatIslandFactory(factory: CanvasChatIslandFactory): IDisposable {
	islandFactory = factory;
	return toDisposable(() => {
		if (islandFactory === factory) {
			islandFactory = undefined;
		}
	});
}

/** The island for a canvas tab; undefined where no chat editor provides one (the web build). */
export function createCanvasChatIsland(instantiationService: IInstantiationService, parent: HTMLElement, canvasId: string): ICanvasChatIsland | undefined {
	return islandFactory?.(instantiationService, parent, canvasId);
}
