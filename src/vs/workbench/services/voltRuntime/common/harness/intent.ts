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
	/** Build a UI from a reference image (a design file or an attached screenshot). */
	readonly matchesDesign?: boolean;
	/** An open-ended change ("make it production ready", "harden", "refactor") that can alter what callers see. */
	readonly broadChange?: boolean;
	/** The request is about making tests pass or keeping them green. */
	readonly mentionsTests?: boolean;
	/** Design alternatives to pick from ("5 sidebar alternatives", "mock up three layouts"): mockups_render. */
	readonly wantsMockups?: boolean;
	/** The app's own screens shown back ("all the screens in light and dark"): screens_capture. */
	readonly wantsScreens?: boolean;
	/** How they asked to be answered - form, completeness, lookup. Every lane reads this. */
	readonly shape: IRequestShape;
}

export interface IIntentContext {
	/** A workspace folder is open. Without one there is nothing to edit or run. */
	readonly hasWorkspace?: boolean;
	/** Later turns in a coding conversation stay in the coding lanes. */
	readonly priorLane?: VoltLane;
	/** Attached files and images, by path or name. */
	readonly attachments?: readonly string[];
}

const BROAD_CHANGE = /\b(?:production[- ]ready|prod[- ]ready|harden|robust(?:ness)?|best practices|clean ?up|refactor|moderni[sz]e|overhaul|rearchitect|rewrite)\b/i;

const TESTS_REF = /\b(?:tests?|specs?|test suite|npm test|pytest|jest|vitest|mocha|unit tests?|failing|passing)\b/i;

const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif|avif)\b/i;

/** Building or matching a UI, as opposed to describing or editing an image. */
const DESIGN_VERB = /\b(?:build|implement|recreate|replicate|reproduce|clone|match|copy|code up|turn .{0,30} into|make (?:it|this|a page|the page) (?:look|match))/i;

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

/**
 * The user wants to see the running thing. Pronouns ("it", "this") only count after a visual
 * verb ("show me it", "open this"): "check it with a simulation" or "run this repo's tests" is not a preview.
 */
const PREVIEW_INTENT = /\b(?:preview|open|show|see|view|look at)\b[^.?!]{0,40}\b(?:app|site|website|page|server|project|frontend|front-end|ui|it|this|the (?:thing|result|game|demo)|in (?:the |a )?browser|locally|on localhost)\b|\b(?:run|start|launch|serve|spin up|boot)\b[^.?!]{0,30}\b(?:app|site|website|page|(?:dev |web |http )?server|frontend|front-end|ui|game|demo|locally|on localhost|in (?:the |a )?browser)\b|\b(?:check|test)\b[^.?!]{0,30}\b(?:in (?:the |a )?browser|on localhost|the (?:ui|page|site|website|frontend))\b|\b(?:dev server|localhost|live preview|hot reload|in the browser|show me (?:the|what|how it looks))\b|\bmake it (?:run|work)\b|\bcan i see\b|\blet'?s see it\b/i;

const CODE_FENCE = /```/;

/** Parts of a UI that alternatives are asked for. */
const UI_NOUN = '(?:side ?bar|nav ?bar|nav(?:igation)?|header|footer|page|screen|ui|ux|layout|button|card|form|modal|dialog|menu|hero|landing|dashboard|component|widget|design|logo|icon|theme|palette|onboarding|empty state|table|chart|list|tabs?|toolbar|banner|pricing|profile|settings|log ?in|sign ?(?:in|up)|checkout|home ?page|website|site|app|style|look)';
const MOCKUP_INTENT = new RegExp(`\\bmock[- ]?ups?\\b|\\bwire ?frames?\\b|\\b${UI_NOUN}s? (?:alternatives?|variations?|variants?|options|ideas|concepts|directions|versions|designs|explorations)\\b|\\b(?:alternatives?|variations?|variants?|options|ideas|concepts|directions|versions|designs|explorations) (?:for|of) (?:the |our |my |a |an |this )?[\\w -]{0,30}?${UI_NOUN}\\b|\\bdesign (?:alternatives?|options|ideas|directions|concepts)\\b`, 'i');
const SCREENS_INTENT = /\b(?:(?:all|every|each) (?:of )?(?:the |our |my )?(?:app'?s? |current |existing |mobile |web )?(?:screens|pages|views)|(?:current|existing|app'?s?|mobile) screens|screen ?shots? of (?:all|every|each|the)|inspect (?:the |our |my )?(?:app|ui|screens|pages|mobile)|(?:light|dark) (?:and|&|\/) (?:light|dark)(?: (?:mode|theme)s?)?)\b/i;

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
	const smashedQuestion = !raw.includes(' ') && QUESTION_STEM.test(raw);
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

	const matchesDesign = hasWorkspace && mode !== 'ask' && DESIGN_VERB.test(raw)
		&& (IMAGE_FILE.test(raw) || (context.attachments ?? []).some(name => IMAGE_FILE.test(name)));
	if (matchesDesign) { signals.push('design-reference'); }

	const broadChange = hasWorkspace && mode !== 'ask' && mode !== 'plan' && BROAD_CHANGE.test(raw);
	if (broadChange) { signals.push('broad-change'); }

	const mentionsTests = hasWorkspace && mode !== 'ask' && mode !== 'plan' && TESTS_REF.test(raw);
	if (mentionsTests) { signals.push('tests'); }

	const wantsMockups = MOCKUP_INTENT.test(raw);
	if (wantsMockups) { signals.push('mockups'); }
	const wantsScreens = SCREENS_INTENT.test(raw);
	if (wantsScreens) { signals.push('screens'); }

	let lane: VoltLane;

	if (slashMission || mode === 'multitask') {
		lane = 'mission';
		signals.push(slashMission ? 'slash-mission' : 'mode-multitask');
	} else if (slashChat || mode === 'ask') {
		lane = 'chat';
		signals.push(slashChat ? 'slash-chat' : 'mode-ask');
	} else if (slashFast) {
		lane = 'fast';
		signals.push('slash-fast');
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
	} else if (!wantsPreview && !mentionsTests && isFast(raw, { codingVerb, sentences, words, hasPath, conjunctions, bullets })) {
		lane = 'fast';
	} else {
		lane = 'agent';
		signals.push('default-agent');
	}

	// "5 sidebar alternatives" has no coding verb, but it is work on the project shown as a gallery,
	// not a question to answer in prose.
	if (lane === 'chat' && (wantsMockups || wantsScreens) && hasWorkspace && mode !== 'ask' && !slashChat) {
		lane = 'agent';
		signals.push('gallery');
	}

	// Follow-ups inside a running coding conversation should not drop to chat just because the
	// user typed a short question ("does it compile?") - keep the coding lane so tools stay.
	if (lane === 'chat' && (context.priorLane === 'agent' || context.priorLane === 'mission') && (referencesWorkspace || wantsPreview) && mode !== 'ask') {
		lane = context.priorLane;
		signals.push('sticky-prior-lane');
	}

	const definition = laneDefinition(lane);
	let groups = filterGroupsByMode(definition.groups, mode);
	if ((wantsWeb || shape.lookup) && !groups.includes('web')) {
		groups = filterGroupsByMode([...groups, 'web'], mode);
	}
	const budget = shape.lookup
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
		...(matchesDesign ? { matchesDesign } : {}),
		...(broadChange ? { broadChange } : {}),
		...(mentionsTests ? { mentionsTests } : {}),
		...(wantsMockups ? { wantsMockups } : {}),
		...(wantsScreens ? { wantsScreens } : {}),
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
