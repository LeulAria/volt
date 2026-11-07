/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * The chat background settings, one section, so no key is a prefix of another: a change event's
 * `affectsConfiguration` looks only at the first key that starts with the one asked about, so
 * `x.background` was missed whenever `x.backgroundDim` changed with it.
 */
export const AGENT_CHAT_BACKGROUND_SECTION = 'volt.chat.background';

/** The picture behind the agent chat: `none`, a built-in picture's id, or an image file's path. */
export const AGENT_CHAT_BACKGROUND_SETTING = `${AGENT_CHAT_BACKGROUND_SECTION}.image`;

/** How much black (white in a light theme) lies over the picture, in percent. */
export const AGENT_CHAT_BACKGROUND_DIM_SETTING = `${AGENT_CHAT_BACKGROUND_SECTION}.dim`;

/** The picture is seen through a grid of square pixels. */
export const AGENT_CHAT_BACKGROUND_PIXELS_SETTING = `${AGENT_CHAT_BACKGROUND_SECTION}.pixelGrid`;

/** The picture stays, darker, behind a chat once it has messages; off, only a new chat shows it. */
export const AGENT_CHAT_BACKGROUND_IN_CHATS_SETTING = `${AGENT_CHAT_BACKGROUND_SECTION}.inConversations`;

export const AGENT_CHAT_BACKGROUND_NONE = 'none';
export const AGENT_CHAT_BACKGROUND_DEFAULT = 'orbit';
export const AGENT_CHAT_BACKGROUND_DEFAULT_DIM = 55;
export const AGENT_CHAT_BACKGROUND_MAX_DIM = 90;
/** A drawn background is faint already: it takes this share of Dim (40% at the default). */
const DRAWN_DIM_SHARE = 8 / 11;

/** The image types a custom background can be chosen from. */
export const AGENT_CHAT_BACKGROUND_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

export interface IAgentChatBackgroundPreset {
	readonly id: string;
	readonly label: string;
	/** What the picture shows. */
	readonly description: string;
	/** The part kept in view when the picture is cropped to the chat (a CSS background position). */
	readonly position: string;
	/** Black added for a bright picture, 0 to 1, over the dim setting. */
	readonly shade: number;
	/** Drawn live in the chat (agentChatDrawings.ts), not shown as a picture; its pictures are a still of it, for Settings. */
	readonly drawn?: AgentChatDrawing;
}

/** The backgrounds drawn live: Orbit animated, the Volt bolt in fine lines, a halftone dot field. */
export type AgentChatDrawing = 'orbit' | 'volt' | 'halftone';

/** Built-in pictures, in media/chatBackgrounds as `<id>.webp` and `<id>-thumb.webp`. A drawn one needs only its thumbnail. */
export const AGENT_CHAT_BACKGROUND_PRESETS: readonly IAgentChatBackgroundPreset[] = [
	{ id: 'orbit', label: localize('voltChatBackground.orbit', "Orbit"), description: localize('voltChatBackground.orbitDesc', "An agent's steps orbiting a dotted planet, animated"), position: '50% 30%', shade: 0, drawn: 'orbit' },
	{ id: 'volt', label: localize('voltChatBackground.volt', "Volt"), description: localize('voltChatBackground.voltDesc', "The Volt bolt, large, in fine lines"), position: '50% 50%', shade: 0, drawn: 'volt' },
	{ id: 'halftone', label: localize('voltChatBackground.halftone', "Halftone"), description: localize('voltChatBackground.halftoneDesc', "A field of dots fading out from the top corner"), position: '50% 50%', shade: 0, drawn: 'halftone' },
	{ id: 'axum', label: localize('voltChatBackground.axum', "Axum"), description: localize('voltChatBackground.axumDesc', "The obelisks of Axum by moonlight"), position: '50% 45%', shade: 0 },
	{ id: 'lalibela', label: localize('voltChatBackground.lalibela', "Lalibela"), description: localize('voltChatBackground.lalibelaDesc', "The Church of Saint George, Lalibela"), position: '50% 30%', shade: 0 },
	{ id: 'gondar', label: localize('voltChatBackground.gondar', "Gondar"), description: localize('voltChatBackground.gondarDesc', "Fasil Ghebbi, Gondar, at night"), position: '50% 40%', shade: 0 },
	{ id: 'harar', label: localize('voltChatBackground.harar', "Harar"), description: localize('voltChatBackground.hararDesc', "The walls of Harar at sunset"), position: '50% 40%', shade: 0.33 },
];

export type AgentChatBackground =
	| { readonly kind: 'none' }
	| { readonly kind: 'preset'; readonly preset: IAgentChatBackgroundPreset }
	/** An image file: a path, or a URI for one outside the local disk. */
	| { readonly kind: 'file'; readonly location: string };

/** Reads the setting. Anything that is not `none` or a built-in picture's id is an image file. */
export function resolveAgentChatBackground(value: unknown): AgentChatBackground {
	const text = typeof value === 'string' ? value.trim() : AGENT_CHAT_BACKGROUND_DEFAULT;
	if (!text || text.toLowerCase() === AGENT_CHAT_BACKGROUND_NONE) {
		return { kind: 'none' };
	}
	const preset = AGENT_CHAT_BACKGROUND_PRESETS.find(candidate => candidate.id === text.toLowerCase());
	return preset ? { kind: 'preset', preset } : { kind: 'file', location: text };
}

/** How a built-in background is drawn live in the chat; undefined for a picture (only a picture gets the pixel grid). */
export function agentChatDrawing(background: AgentChatBackground): AgentChatDrawing | undefined {
	return background.kind === 'preset' ? background.preset.drawn : undefined;
}

/**
 * The dark (or light) over the background, 0 to 0.9: the dim setting (percent, 55 when unset), of
 * which a drawn background takes 8/11, with a bright picture's own shade on top. Light themes lay
 * more white than this over a photo (agentChatBackground.css).
 */
export function agentChatBackgroundDim(value: unknown, background: AgentChatBackground): number {
	const percent = typeof value === 'number' && Number.isFinite(value) ? value : AGENT_CHAT_BACKGROUND_DEFAULT_DIM;
	const dim = Math.min(AGENT_CHAT_BACKGROUND_MAX_DIM, Math.max(0, percent)) / 100 * (agentChatDrawing(background) ? DRAWN_DIM_SHARE : 1);
	const shade = background.kind === 'preset' ? background.preset.shade : 0;
	return Math.round((1 - (1 - dim) * (1 - shade)) * 1000) / 1000;
}
