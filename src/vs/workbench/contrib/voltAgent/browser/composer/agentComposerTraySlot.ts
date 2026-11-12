/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IVoltAgentWindowService, IVoltComposerTray } from '../../../../services/voltPlugins/browser/voltAgentWindow.js';
import { IAgentComposerTerminalRuns } from './agentComposerChips.js';

const CHIP_CLASS = 'volt-agent-composer-chip';

/**
 * Where a feature's card goes in a chat's composer (`IVoltAgentWindowService.registerComposerTray`):
 * the card at its place in the composer (`mount`), and its chip, a button of the composer's own that
 * stays in the chip row whether a card fills it or not. The card comes and goes with its feature's
 * module, in open chats too.
 */
export class AgentComposerTraySlot extends Disposable {

	/** For the row above the composer (AgentComposerChips). */
	readonly chip: IAgentComposerTerminalRuns;
	private readonly chipElement: HTMLButtonElement;
	private readonly onDidChangeChip = this._register(new Emitter<void>());
	private readonly tray = this._register(new MutableDisposable<IVoltComposerTray>());
	private sessionKey: string | undefined;
	private place: { readonly composer: HTMLElement; readonly before: HTMLElement } | undefined;

	constructor(
		private readonly id: string,
		private readonly onLayout: () => void,
		@IVoltAgentWindowService private readonly agentWindow: IVoltAgentWindowService,
	) {
		super();
		const chip = this.chipElement = $(`button.${CHIP_CLASS}.hidden`) as HTMLButtonElement;
		chip.type = 'button';
		this.chip = { element: chip, get visible() { return !chip.classList.contains('hidden'); }, onDidChange: this.onDidChangeChip.event };
		this._register(agentWindow.onDidChangeComposerTrays(id => id === this.id && this.sync()));
	}

	/** Cards go into `composer`, right before `before`; the chip is in the row already. */
	mount(composer: HTMLElement, before: HTMLElement): void {
		this.place = { composer, before };
		this.sync();
	}

	setSession(sessionKey: string | undefined): void {
		this.sessionKey = sessionKey;
		this.tray.value?.setSession(sessionKey);
	}

	private sync(): void {
		const factory = this.agentWindow.composerTray(this.id);
		if (!factory) {
			this.remove();
			return;
		}
		const place = this.place;
		if (this.tray.value || !place) {
			return;
		}
		const tray = factory({
			chip: this.chipElement,
			chipChanged: () => this.onDidChangeChip.fire(),
			layout: () => this.onLayout(),
		});
		this.tray.value = tray;
		place.composer.insertBefore(tray.element, place.before.parentElement === place.composer ? place.before : null);
		tray.setSession(this.sessionKey);
	}

	/** The card went (its feature was turned off): its element goes, and the chip is the composer's empty one again. */
	private remove(): void {
		const tray = this.tray.value;
		if (!tray) {
			return;
		}
		tray.element.remove();
		this.tray.clear();
		const chip = this.chipElement;
		chip.replaceChildren();
		for (const name of chip.getAttributeNames()) {
			if (name !== 'type') {
				chip.removeAttribute(name);
			}
		}
		chip.className = `${CHIP_CLASS} hidden`;
		this.onDidChangeChip.fire();
		this.onLayout();
	}
}
