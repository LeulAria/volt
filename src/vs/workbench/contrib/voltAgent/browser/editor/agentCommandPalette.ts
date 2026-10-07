/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';

/** What a palette entry can check before it is offered: the chat the palette was opened in. */
export interface IAgentPaletteContext {
	/** The chat on screen, if any. */
	readonly sessionId: string | undefined;
	/** Its agent is working on a turn. */
	readonly running: boolean;
}

/**
 * One row of the Cmd+K agent palette. It runs a command, so the same action stays reachable from
 * the command palette and keybindings; the row only adds a short label for the chat.
 */
export interface IAgentPaletteEntry {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly commandId: string;
	/** Arguments for the command; by default it gets none and acts on the active chat. */
	args?(context: IAgentPaletteContext): readonly unknown[];
	/** Shown instead of the command's own keybinding. */
	readonly keybindingLabel?: string;
	/** Lower comes first; entries without one go last, in registration order. */
	readonly order?: number;
	/** Hidden when false. */
	enabled?(context: IAgentPaletteContext): boolean;
}

const entries = new Map<string, IAgentPaletteEntry>();

/** Cmd+K (Ctrl+K off the Mac) with nothing else held: the key that opens the agent palette in a chat. */
export function isAgentPaletteKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac = isMacintosh): boolean {
	const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
	return primary && !e.shiftKey && !e.altKey && (e.code === 'KeyK' || e.key.toLowerCase() === 'k');
}

/**
 * Adds a row to the agent palette (scheduled tasks, compaction and the like register theirs).
 * A second entry with the same id replaces the first. Dispose to remove it.
 */
export function registerAgentPaletteEntry(entry: IAgentPaletteEntry): IDisposable {
	entries.set(entry.id, entry);
	return toDisposable(() => {
		if (entries.get(entry.id) === entry) {
			entries.delete(entry.id);
		}
	});
}

/** The rows the palette offers for this chat, in order. */
export function agentPaletteEntries(context: IAgentPaletteContext): IAgentPaletteEntry[] {
	const all = [...entries.values()];
	return all
		.filter(entry => entry.enabled?.(context) ?? true)
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => (a.entry.order ?? Number.MAX_SAFE_INTEGER) - (b.entry.order ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
		.map(({ entry }) => entry);
}

interface IAgentPalettePick extends IQuickPickItem {
	readonly entry: IAgentPaletteEntry;
}

/** Opens the agent palette ("Agent commands") and runs the picked row's command. */
export async function showAgentCommandPalette(accessor: ServicesAccessor, context: IAgentPaletteContext): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const keybindingService = accessor.get(IKeybindingService);
	const commandService = accessor.get(ICommandService);
	const items = agentPaletteEntries(context).map((entry): IAgentPalettePick => ({
		label: entry.label,
		description: [entry.description, entry.keybindingLabel].filter(Boolean).join('  ') || undefined,
		keybinding: entry.keybindingLabel ? undefined : keybindingService.lookupKeybinding(entry.commandId),
		entry,
	}));
	const picked = await quickInputService.pick(items, {
		title: localize('voltAgent.palette.title', "Agent commands"),
		placeHolder: localize('voltAgent.palette.placeholder', "Run an agent command"),
		matchOnDescription: true,
	});
	if (picked) {
		await commandService.executeCommand(picked.entry.commandId, ...(picked.entry.args?.(context) ?? []));
	}
}
