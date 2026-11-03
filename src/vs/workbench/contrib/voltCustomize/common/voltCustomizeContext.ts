/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltCustomizePart } from './voltCustomizeParts.js';
import { voltLookCssVariable, voltLookTargetSetting, voltLookToken } from './voltLookTokens.js';
import { VOLT_SLOT_ITEMS } from './voltSlots.js';

/**
 * A piece of Volt dragged from the Playground devtools into a chat: the composer shows it as a
 * chip and sends `value` (a block the agent reads) in its place.
 */
export const VOLT_CONTEXT_MIME = 'application/vnd.volt.customize-context+json';

export interface IVoltContextDrag {
	readonly label: string;
	readonly value: string;
}

/** Opens the devtools on a part: the command a part chip runs when clicked (`id` from its block). */
export const REVEAL_VOLT_PART_COMMAND_ID = 'volt.devtools.reveal';

/**
 * The part id a chip's block names (`<volt_part id="composer" ...>`, or a capability's
 * `<volt_capability id="volt/usage" ...>`), if it is one.
 */
export function voltPartIdFromContext(value: string | undefined): string | undefined {
	return value ? /^<volt_(?:part|capability) id="([^"]+)"/.exec(value)?.[1] : undefined;
}

export function encodeVoltContextDrag(drag: IVoltContextDrag): string {
	return JSON.stringify(drag);
}

export function decodeVoltContextDrag(text: string | undefined): IVoltContextDrag | undefined {
	if (!text) {
		return undefined;
	}
	try {
		const value = JSON.parse(text);
		return typeof value?.label === 'string' && typeof value?.value === 'string' ? { label: value.label, value: value.value } : undefined;
	} catch {
		return undefined;
	}
}

/** What the agent gets for a part: what it is, what styles and places it now, and where to change it. */
export function voltPartContext(part: IVoltCustomizePart, read: (setting: string) => unknown, slotItems?: readonly string[]): string {
	const lines = [`<volt_part id="${part.id}" label="${part.label}">`, part.description, `Element: \`${part.selector}\``];
	if (part.tokens?.length) {
		lines.push('Tokens (look.json "tokens"):');
		for (const id of part.tokens) {
			const setting = voltLookTargetSetting(id);
			const token = voltLookToken(id);
			const value = setting ? read(setting) : undefined;
			// allow-any-unicode-next-line
			lines.push(`- ${id} = ${JSON.stringify(value)}${token ? ` (default ${token.default}, ${token.minimum}–${token.maximum}, CSS ${voltLookCssVariable(id)})` : ''}`);
		}
	}
	if (part.colors?.length) {
		lines.push(`Theme colors (look.json "colors"): ${part.colors.join(', ')}`);
	}
	if (part.layout?.length) {
		lines.push(`Layout fields (layout.json): ${part.layout.join(', ')}`);
	}
	if (part.slot) {
		const items = (slotItems ?? []).map(id => VOLT_SLOT_ITEMS.find(item => item.id === id)?.label ? `${id} (${VOLT_SLOT_ITEMS.find(item => item.id === id)!.label})` : id);
		lines.push(`Slot "${part.slot}" (layout.json "slots"), holds: ${items.join(', ') || 'nothing'}`);
	}
	if (part.files?.length) {
		lines.push(`CSS (read only, to understand it): ${part.files.join(', ')}`);
	}
	lines.push('Change it through look.json / layout.json in the Playground draft (see AGENTS.md), not Volt\'s source.', '</volt_part>');
	return lines.join('\n');
}

/** The same for one of Volt's buttons. */
export function voltSlotItemContext(itemId: string, slot: string): string {
	const item = VOLT_SLOT_ITEMS.find(entry => entry.id === itemId);
	return [
		`<volt_part id="${itemId}" label="${item?.label ?? itemId}">`,
		item?.description ?? '',
		item?.defaultSlot
			? `A button in slot "${slot}" (its own slot is "${item.defaultSlot}"). Move, reorder or hide it with layout.json "slots" (see AGENTS.md).`
			: `A button in slot "${slot}". It has no slot of its own: it shows only where layout.json "slots" names it (see AGENTS.md).`,
		'</volt_part>',
	].join('\n');
}
