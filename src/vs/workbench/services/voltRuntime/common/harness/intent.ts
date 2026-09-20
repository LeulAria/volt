/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { modePolicy, VoltMode } from '../modes.js';
import { CapabilityGroup, ILaneBudget, laneDefinition, VoltLane } from './lanes.js';
import { detectRequestShape, IRequestShape } from './requestShape.js';

/**
 * Deterministic intent router. Runs on every send() in well under a millisecond and never calls
 * a model. It decides the lane, the capability groups the model may see, and the two hints the
 * context pack is allowed to inject (preview and web). A wrong guess is cheap: the model can
 * move up a lane with `request_capabilities`, so the router is tuned to under-grant.
 */
export interface IIntent {
	readonly lane: VoltLane;
	/** Why this lane was chosen. Logged with the run so routing is auditable. */
	readonly signals: readonly string[];
	readonly groups: readonly CapabilityGroup[];
	readonly budget: ILaneBudget;
	/** The user wants to see something running. Only then may the run-plan hint be injected. */
	readonly wantsPreview: boolean;
	/** The answer likely depends on information outside the workspace. */
	readonly wantsWeb: boolean;
	/** The request references the workspace (paths, mentions, "this repo"). */
	readonly referencesWorkspace: boolean;
	/** How they asked to be answered - form, completeness, lookup. Every lane reads this. */
	readonly shape: IRequestShape;
}

export interface IIntentContext {
	/** A workspace folder is open. Without one there is nothing to edit or run. */
	readonly hasWorkspace?: boolean;
	/** Later turns in a coding conversation stay in the coding lanes. */
	readonly priorLane?: VoltLane;
}

const CODING_VERBS = /\b(fix|add|implement|refactor|rename|create|update|remove|delete|write|build|migrate|install|run|test|debug|deploy|change|make|edit|move|replace|convert|generate|set ?up|configure|wire|hook up|extract|inline|split|merge|clean ?up|optimi[sz]e|speed up|improve|rewrite|port|upgrade|bump|revert|patch|scaffold|bootstrap|integrate|connect|enable|disable|introduce|drop|swap|style|restyle|redesign|polish|animate|center|align|resize|format|lint|type-?check|compile|bundle|ship|release|publish)\b/i;

const SMALL_CHANGE = /\b(rename|typo|comment|log(ging)? (line|statement)|console\.log|bump|version|one[- ]liner|quick|small|tiny|minor|import|unused|semicolon|indent|whitespace|trailing|spacing|color|colour|padding|margin|label|copy|text|string|wording|placeholder|tooltip|default value|constant|flag|toggle)\b/i;

const MISSION_MARKERS = /\b(entire|whole|end[- ]to[- ]end|from scratch|full(y)?|complete(ly)?|production[- ]ready|all (of )?the|every|migrate .{0,40}\bto\b|rewrite .{0,30}\bin\b|multi[- ]step|roadmap|milestones?|phases?|mission)\b/i;

const QUESTION_START = /^(how (much|many|do(es)?|is|are|can|could|would|should|to|long|far|old)|what('s| is| are| does| do| was| were| would| should| about)|who|when|where|why|which|is|are|does|do|can|could|should|would|will|did|explain|tell me|define|describe|compare|difference between|summari[sz]e|meaning of|translate|calculate|estimate|recommend|suggest|any idea|thoughts on|opinion on)\b/i;

/** Smashed questions ("whatistheproject") still start with a question stem. */
const QUESTION_STEM = /^(how|what|who|when|where|why|which|is|are|does|do|can|could|should|would|will|did|explain|tell)/i;

/** "whatistheproject" / "thisrepo" still name the workspace. */
const SMASHED_WORKSPACE = /(this|the|our|my)?(project|repo|repository|codebase|workspace)\b/i;

const HOW_TO = /^(how (do|to|can|would|should|might) (i|we|you|one)?\b|what('s| is) the (best|right|proper|idiomatic) way|should i|is it (possible|better|ok|okay) to|where (do|should|would) (i|we))/i;

const WEB_MARKERS = /\b(price|prices|pricing|cost|costs|how much|latest|news|today|current|currently|release date|released|version of|docs? for|documentation|search (the )?web|look ?up|google|weather|stock|exchange rate|population|capital of|who (is|was)|when (did|was|is)|in (the )?(uae|usa|uk|eu|india|china|japan|dubai|abu dhabi)|\b\d{4}\b (model|edition)|specs?|specifications|review(s)? of|vs\.?|versus|compare .{0,30} (and|vs|to))\b/i;

const URL_RE = /https?:\/\/\S+/i;

const PATH_RE = /(^|[\s"'`(])((\.{1,2}|~)?\/?[\w.-]+\/[\w./-]+|[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|css|scss|less|html|vue|svelte|json|ya?ml|toml|md|sql|sh|zsh|txt|env|lock))\b/i;

const MENTION_RE = /(^|\s)@[\w./-]+/;

const WORKSPACE_REF = /\b(this|the|our|my) (repo|repository|code ?base|project|app|application|file|function|class|component|module|package|service|folder|directory|workspace|test|tests|branch|pr|pull request)\b|\bin (here|the code)\b/i;

const PREVIEW_INTENT = /\b(run|start|launch|serve|spin up|boot|preview|open|show|see|view|look at|check|test)\b[^.?!]{0,40}\b(app|site|website|page|server|project|dev|frontend|front-end|ui|it|this|the (thing|result|game|demo)|in (the |a )?browser|locally|on localhost)\b|\b(dev server|localhost|live preview|hot reload|in the browser|show me (the|what|how it looks))\b|\bmake it (run|work)\b|\bcan i see\b|\blet'?s see it\b/i;

const CODE_FENCE = /```/;

const PING = /^(?:(?:hey|hi|hello|yo|sup|thanks|thank you|thx|ty|ok(?:ay)?|k|cool|nice|got it|cheers|bye|ping|pong|test(?:ing)?|just testing|checking|check(?:ing)? in|anyone there|you there|are you (?:there|working|ok)|can you (?:hear|see) me|what'?s up|how are you|gm|gn)[\s!.?,]*)+$/i;

/** Check-ins like "testing" / "hello" / "thanks" - answer immediately, no tools. */
export function isConversationalPing(text: string): boolean {
	const raw = text.trim();
	if (!raw || raw.length > 48) {
		return false;
	}
	if (PING.test(raw)) {
		return true;
	}
	if (QUESTION_START.test(raw) || QUESTION_STEM.test(raw) || raw.includes('?') || SMASHED_WORKSPACE.test(raw)) {
		return false;
	}
	const words = raw.split(/\s+/).filter(Boolean);
	return words.length <= 2 && !/[/?@#]/.test(raw) && !PATH_RE.test(raw) && !URL_RE.test(raw) && !CODING_VERBS.test(raw);
}

/** Local reply for a ping. Never calls a model - the point is to prove the harness is alive. */
export function pingReply(text: string): string {
	const raw = text.trim().toLowerCase().replace(/[!?.,]+$/g, '');
	if (/^(thanks|thank you|thx|ty)$/.test(raw)) {
		return 'You\'re welcome.';
	}
	if (/^(hey|hi|hello|yo|sup)$/.test(raw)) {
		return 'Hey.';
	}
	if (/^(ok|okay|k|got it|cool|nice)$/.test(raw)) {
		return 'Okay.';
	}
	return 'Here.';
}

export function classifyIntent(text: string, mode: VoltMode, context: IIntentContext = {}): IIntent {
	const raw = text.trim();
	const signals: string[] = [];
	const lower = raw.toLowerCase();
	const hasWorkspace = context.hasWorkspace !== false;

	const slashMission = /^\/mission\b/i.test(raw);
	const slashFast = /^\/(fast|quick)\b/i.test(raw);
	const slashChat = /^\/(ask|chat|q)\b/i.test(raw);

	const hasUrl = URL_RE.test(raw);
	const hasPath = PATH_RE.test(raw);
	const hasMention = MENTION_RE.test(raw);
	const hasFence = CODE_FENCE.test(raw);
	const smashedQuestion = !raw.includes(' ') && QUESTION_STEM.test(raw) && !PING.test(raw);
	const questionShape = QUESTION_START.test(raw) || raw.endsWith('?') || smashedQuestion;
	const referencesWorkspace = hasPath || hasMention || hasFence || WORKSPACE_REF.test(raw) || (questionShape && SMASHED_WORKSPACE.test(raw));
	const codingVerb = CODING_VERBS.test(raw);
	const sentences = raw.split(/[.!?]+\s|\n+/).filter(s => s.trim().length > 0).length;
	const words = raw.split(/\s+/).filter(Boolean).length;
	const conjunctions = (lower.match(/\b(and|then|also|plus|as well as|after that)\b/g) ?? []).length;
	const bullets = (raw.match(/^\s*([-*•]|\d+[.)])\s+/gm) ?? []).length;

	if (hasUrl) { signals.push('url'); }
	if (hasPath) { signals.push('path'); }
	if (hasMention) { signals.push('mention'); }
	if (hasFence) { signals.push('code-fence'); }
	if (referencesWorkspace && !hasPath && !hasMention && !hasFence) { signals.push('workspace-ref'); }
	if (codingVerb) { signals.push('coding-verb'); }
	if (questionShape) { signals.push('question'); }

	const shape = detectRequestShape(raw, { referencesWorkspace, coding: codingVerb });
	const wantsWeb = hasUrl || shape.lookup || (WEB_MARKERS.test(raw) && !referencesWorkspace) || (questionShape && !referencesWorkspace && !codingVerb && shape.lookup);
	if (wantsWeb) { signals.push('web'); }
	if (shape.form === 'table' || shape.form === 'list') { signals.push(shape.form); }
	if (shape.enumerate) { signals.push('enumerate'); }

	const wantsPreview = hasWorkspace && PREVIEW_INTENT.test(raw) && !(questionShape && !codingVerb && !referencesWorkspace);
	if (wantsPreview) { signals.push('preview'); }

	let lane: VoltLane;

	if (slashMission || mode === 'multitask') {
		lane = 'mission';
		signals.push(slashMission ? 'slash-mission' : 'mode-multitask');
	} else if (slashChat || mode === 'ask') {
		lane = 'chat';
		signals.push(slashChat ? 'slash-chat' : 'mode-ask');
		if (isConversationalPing(raw)) {
			signals.push('ping');
		}
	} else if (slashFast) {
		lane = 'fast';
		signals.push('slash-fast');
	} else if (isConversationalPing(raw)) {
		lane = 'chat';
		signals.push('ping');
	} else if (!hasWorkspace) {
		// Nothing to edit or run; the best we can do is answer.
		lane = 'chat';
		signals.push('no-workspace');
	} else if (isMission(raw, { codingVerb, conjunctions, bullets, sentences, words })) {
		lane = 'mission';
	} else if (questionShape && !codingVerb && !wantsPreview) {
		// "how much is X", "what does this function do", "explain the auth flow"
		lane = 'chat';
		signals.push(referencesWorkspace ? 'question-about-workspace' : 'plain-question');
	} else if (HOW_TO.test(raw) && !wantsPreview) {
		// "how do I add a route here" wants an explanation, not an edit.
		lane = 'chat';
		signals.push('how-to-question');
	} else if (!codingVerb && !referencesWorkspace && !wantsPreview && context.priorLane !== 'agent' && context.priorLane !== 'mission') {
		// Statements with no coding verb and no workspace anchor ("thanks", "nissan kicks uae price")
		lane = 'chat';
		signals.push('no-coding-signal');
	} else if (isFast(raw, { codingVerb, sentences, words, hasPath, conjunctions, bullets })) {
		lane = 'fast';
	} else {
		lane = 'agent';
		signals.push('default-agent');
	}

	// Follow-ups inside a running coding conversation should not drop to chat just because the
	// user typed a short question ("does it compile?") - keep the coding lane so tools stay.
	if (lane === 'chat' && !signals.includes('ping') && (context.priorLane === 'agent' || context.priorLane === 'mission') && (referencesWorkspace || wantsPreview) && mode !== 'ask') {
		lane = context.priorLane;
		signals.push('sticky-prior-lane');
	}

	const definition = laneDefinition(lane);
	let groups = filterGroupsByMode(definition.groups, mode);
	if (signals.includes('ping')) {
		groups = filterGroupsByMode(['meta'], mode);
	} else if ((wantsWeb || shape.lookup) && !groups.includes('web')) {
		groups = filterGroupsByMode([...groups, 'web'], mode);
	}
	const budget = signals.includes('ping')
		? { maxToolCalls: 0, maxModelCalls: 1 }
		: shape.lookup
			? {
				maxToolCalls: Math.max(definition.budget.maxToolCalls, 24),
				maxModelCalls: Math.max(definition.budget.maxModelCalls, 12),
			}
			: definition.budget;

	return {
		lane,
		signals,
		groups,
		budget,
		wantsPreview,
		wantsWeb,
		referencesWorkspace,
		shape,
	};
}

interface IShapeSignals {
	codingVerb: boolean;
	conjunctions: number;
	bullets: number;
	sentences: number;
	words: number;
}

function isMission(raw: string, s: IShapeSignals): boolean {
	if (!s.codingVerb) {
		return false;
	}
	const markers = MISSION_MARKERS.test(raw);
	const verbCount = (raw.match(new RegExp(CODING_VERBS.source, 'gi')) ?? []).length;
	// Several deliverables in one breath, a bulleted spec, or an explicit "entire/end-to-end" scope.
	if (s.bullets >= 3 && verbCount >= 2) {
		return true;
	}
	if (verbCount >= 3 && s.conjunctions >= 3) {
		return true;
	}
	if (markers && (verbCount >= 2 || s.words > 60)) {
		return true;
	}
	return s.words > 180 && verbCount >= 2;
}

function isFast(raw: string, s: { codingVerb: boolean; sentences: number; words: number; hasPath: boolean; conjunctions: number; bullets: number }): boolean {
	if (!s.codingVerb || s.bullets > 0) {
		return false;
	}
	if (s.sentences > 2 || s.words > 28 || s.conjunctions > 1) {
		return false;
	}
	// Named target plus a small-change word, or a very short imperative on a path.
	return SMALL_CHANGE.test(raw) || (s.hasPath && s.words <= 14);
}

/** Mode policy can only tighten the lane, never widen it. */
export function filterGroupsByMode(groups: readonly CapabilityGroup[], mode: VoltMode): CapabilityGroup[] {
	const policy = modePolicy(mode);
	return groups.filter(group => {
		if (group === 'edit') {
			return policy.allowWrites;
		}
		if (group === 'shell') {
			return policy.allowTerminal;
		}
		if (group === 'mcp') {
			return policy.allowMcp;
		}
		if (group === 'agents') {
			return policy.allowWrites;
		}
		return true;
	});
}

/** `request_capabilities` may add groups the current mode still allows. */
export function mergeGrantedGroups(
	current: readonly CapabilityGroup[],
	requested: readonly CapabilityGroup[],
	mode: VoltMode,
): CapabilityGroup[] {
	return filterGroupsByMode([...new Set([...current, ...requested])], mode);
}
