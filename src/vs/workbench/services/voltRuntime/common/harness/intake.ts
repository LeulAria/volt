/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RiskLevel } from '../access/accessTypes.js';
import { VoltMode } from '../modes.js';
import { classifyIntent, IIntent, IIntentContext } from './intent.js';

/**
 * Request intake. The first thing that happens to a `send()`: strip the social wrapper, name
 * the slash command if there is one, and emit the five structured signals the rest of the
 * harness reasons about (web, browser, workspace, autonomy, risk).
 *
 * Lane selection still lives in `classifyIntent` - this module does not re-decide it. It
 * *enriches* the router's opinion so later stages do not have to re-parse the same sentence.
 */

export type SlashCommand = 'mission' | 'fast' | 'chat';

export type AutonomyLevel = 'supervised' | 'assisted' | 'autonomous';

export interface INormalizedRequest {
	/** The original text, trimmed. Slash commands stay; they are part of the request. */
	readonly raw: string;
	/** Same as `raw` with a leading slash command removed. Used by task intelligence. */
	readonly text: string;
	readonly slash?: SlashCommand;
	readonly words: number;
	readonly attachments: readonly string[];
}

export interface IIntentSignals {
	readonly webRequired: boolean;
	readonly browserRequired: boolean;
	readonly workspaceRequired: boolean;
	readonly autonomy: AutonomyLevel;
	/** The *request's* risk, not a tool's. A "delete the database" ask is critical even in chat. */
	readonly risk: RiskLevel;
}

export interface IIntake {
	readonly request: INormalizedRequest;
	readonly intent: IIntent;
	readonly signals: IIntentSignals;
}

const SLASH = /^\/(mission|fast|quick|ask|chat|q)\b/i;

const BROWSER_MARKERS = /\b(in the browser|screenshot|visually|on screen|click|hover|navigate|playwright|puppeteer|live preview|hot reload|looks? (like|right|wrong)|ui (looks?|broke|broken)|css (broke|broken)|layout (shift|broke))\b/i;

const DESTRUCTIVE = /\b(rm\s+-rf|delete (the )?(database|db|prod|production)|drop (table|database)|wipe|destroy|force[- ]push|reset --hard|terraform apply|kubectl delete)\b/i;

const CREDENTIALS = /\b(\.env\b|api[- ]?key|secret|password|token|credentials|id_rsa|private key)\b/i;

const NETWORK_WRITE = /\b(deploy|publish|release|push to (prod|origin|main)|send email|page (someone|on-?call))\b/i;

const SUPERVISED = /\b(ask me|show me (the )?(diff|plan) first|don'?t (run|edit|commit|push) (yet|until)|wait for (me|approval)|dry[- ]run)\b/i;

const AUTONOMOUS = /\b(just (do|fix|ship) it|don'?t ask|no (need to )?ask|fully autonom|yolo|auto[- ](?:approve|accept))\b/i;

export function normalizeRequest(text: string, attachments: readonly string[] = []): INormalizedRequest {
	const raw = text.replace(/^\uFEFF/, '').trim();
	const match = raw.match(SLASH);
	const slash = slashOf(match?.[1]);
	const body = raw.replace(SLASH, '').trim() || raw;
	return {
		raw,
		text: body,
		...(slash ? { slash } : {}),
		words: body.split(/\s+/).filter(Boolean).length,
		attachments,
	};
}

export function detectSignals(text: string, intent: IIntent): IIntentSignals {
	return {
		webRequired: intent.wantsWeb,
		browserRequired: intent.wantsPreview || BROWSER_MARKERS.test(text),
		workspaceRequired: intent.referencesWorkspace,
		autonomy: autonomyOf(text, intent),
		risk: riskOf(text, intent),
	};
}

/**
 * Full intake. One function so a caller cannot classify a request without also producing the
 * signals the planner, the safety boundary, and the orchestrator expect.
 */
export function intake(text: string, mode: VoltMode, context: IIntentContext & { attachments?: readonly string[] } = {}): IIntake {
	const request = normalizeRequest(text, context.attachments ?? []);
	const intent = classifyIntent(request.raw, mode, context);
	return { request, intent, signals: detectSignals(request.raw, intent) };
}

function slashOf(value: string | undefined): SlashCommand | undefined {
	if (!value) {
		return undefined;
	}
	const id = value.toLowerCase();
	if (id === 'mission') {
		return 'mission';
	}
	if (id === 'fast' || id === 'quick') {
		return 'fast';
	}
	if (id === 'ask' || id === 'chat' || id === 'q') {
		return 'chat';
	}
	return undefined;
}

function autonomyOf(text: string, intent: IIntent): AutonomyLevel {
	if (SUPERVISED.test(text) || intent.lane === 'chat') {
		return 'supervised';
	}
	if (AUTONOMOUS.test(text) || intent.lane === 'mission') {
		return 'autonomous';
	}
	return 'assisted';
}

function riskOf(text: string, intent: IIntent): RiskLevel {
	if (DESTRUCTIVE.test(text)) {
		return 'critical';
	}
	if (CREDENTIALS.test(text)) {
		return 'high';
	}
	if (NETWORK_WRITE.test(text)) {
		return 'high';
	}
	if (intent.wantsPreview || /\b(install|migrate|deploy|push)\b/i.test(text)) {
		return 'medium';
	}
	if (intent.lane === 'chat') {
		return 'safe';
	}
	if (intent.lane === 'fast') {
		return 'low';
	}
	return 'medium';
}
