/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { IAgentTerminalQuote } from '../composer/agentTerminalQuote.js';
import { describeAgentTerminalStatus, IAgentTerminalsService, isAgentTerminal } from './agentTerminals.js';

export const IAgentTerminalCopyService = createDecorator<IAgentTerminalCopyService>('agentTerminalCopyService');

/**
 * Remembers what was last selected in each terminal, so a paste into the composer can tell it came
 * from a terminal (Cmd+C, the context menu and copy on selection all copy the selection) and which one.
 */
export interface IAgentTerminalCopyService {
	readonly _serviceBrand: undefined;
	/** The terminal `text` was copied from, when it is what was last selected in one. */
	sourceOf(text: string): IAgentTerminalQuote | undefined;
}

/** Terminals whose last selection is kept. */
const MAX_KEPT = 8;
/** A selection older than this is not matched to a paste. */
const MAX_AGE_MS = 60 * 60_000;

/** Line ends and trailing spaces differ by platform and by how the selection was copied. */
function normalize(text: string): string {
	return text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trim();
}

class AgentTerminalCopyService extends Disposable implements IAgentTerminalCopyService {

	declare readonly _serviceBrand: undefined;

	/** Newest last; a terminal's entry moves to the end when its selection changes. */
	private readonly selections = new Map<ITerminalInstance, { readonly quote: IAgentTerminalQuote; readonly key: string; readonly at: number }>();

	constructor(
		@ITerminalService terminalService: ITerminalService,
		@IAgentTerminalsService private readonly agentTerminals: IAgentTerminalsService,
	) {
		super();
		this._register(terminalService.onAnyInstanceSelectionChange(instance => this.remember(instance)));
	}

	sourceOf(text: string): IAgentTerminalQuote | undefined {
		const key = normalize(text);
		if (!key) {
			return undefined;
		}
		const now = Date.now();
		for (const entry of [...this.selections.values()].reverse()) {
			if (now - entry.at <= MAX_AGE_MS && entry.key === key) {
				return { ...entry.quote, text };
			}
		}
		return undefined;
	}

	private remember(instance: ITerminalInstance): void {
		// A cleared selection keeps the last one: copy-and-clear empties it right after the copy.
		const text = instance.selection;
		const key = text ? normalize(text) : '';
		if (!text || !key) {
			return;
		}
		// What is known now: the terminal may be gone by the time the text is pasted.
		const info = this.agentTerminals.forInstance(instance);
		const cwd = instance.cwd || info?.cwd;
		const quote: IAgentTerminalQuote = {
			text,
			terminal: info?.label ?? instance.title,
			...(info ? { agentTerminalId: info.id, command: info.command, status: describeAgentTerminalStatus(info) } : {}),
			...(info || isAgentTerminal(instance) ? { byAgent: true } : {}),
			...(cwd ? { cwd } : {}),
		};
		this.selections.delete(instance);
		this.selections.set(instance, { quote, key, at: Date.now() });
		while (this.selections.size > MAX_KEPT) {
			this.selections.delete(this.selections.keys().next().value!);
		}
	}
}

registerSingleton(IAgentTerminalCopyService, AgentTerminalCopyService, InstantiationType.Eager);
