/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ACTIVE_PHASES, type AgentActivityPhase, type AgentInputKind, type IAgentActivityContentState, toSeconds } from './model.ts';
import type { IAccessRequestLike, IOrchTaskLike, IOrchThreadLike, IQuestionRequestLike, ISessionMetaLike, ISessionSummaryLike } from './serverShapes.ts';
import { compactStep, type IStepState } from './steps.ts';

/** Everything known about one chat, gathered from the mirrored collections. */
export interface IChatSources {
	readonly meta?: ISessionMetaLike;
	readonly thread?: IOrchThreadLike;
	readonly session?: ISessionSummaryLike;
	/** Tasks whose parent is this chat. */
	readonly tasks?: readonly IOrchTaskLike[];
	readonly questions?: readonly IQuestionRequestLike[];
	/** Pending approvals of this chat. */
	readonly approvals?: readonly IAccessRequestLike[];
	/** Live step from runtime events, when the client follows them. */
	readonly step?: IStepState;
	/** Files changed this turn, from the edits journal. */
	readonly filesChanged?: number;
	/** Provider family, resolved from the model ref through the catalog. */
	readonly provider?: string;
	/** The model's display name ("Claude Opus 5.5"). */
	readonly modelLabel?: string;
}

/** One chat as the Lock Screen, the Dynamic Island and the widgets show it. Times in ms. */
export interface IAgentChatView {
	readonly chatId: string;
	readonly title: string;
	readonly provider: string;
	readonly phase: AgentActivityPhase;
	readonly step: string;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly filesChanged: number;
	readonly queued: number;
	readonly subagents: number;
	readonly inputKind?: AgentInputKind;
	readonly inputPrompt?: string;
	readonly model?: string;
	readonly workspace?: string;
	readonly limitResetAt?: number;
	readonly updatedAt: number;
}

const RUN_STATUSES = new Set(['queued', 'running', 'waiting']);
const LIVE_TASK_STATES = new Set(['queued', 'running', 'waiting']);

/** `claude` from `agent:claude`, `codex` from `model:codex/gpt-5`: used when the catalog has no entry. */
export function providerFromRef(ref: string | undefined): string | undefined {
	if (!ref) {
		return undefined;
	}
	const rest = ref.replace(/^(agent|model):/, '');
	const head = rest.split(/[/:@]/)[0]?.trim().toLowerCase();
	return head || undefined;
}

/** Provider families as the agent window groups them (providerFamily.ts). */
const FAMILIES: Record<string, string> = {
	codex: 'codex', openai: 'codex', claude: 'claude', 'claude-code': 'claude', anthropic: 'claude',
	cursor: 'cursor', 'cursor-acp': 'cursor', grok: 'grok', xai: 'grok', opencode: 'opencode',
	antigravity: 'antigravity', agy: 'antigravity', gemini: 'antigravity', 'gemini-cli': 'antigravity', 'gemini-acp': 'antigravity',
	kimi: 'kimi', muse: 'muse', ollama: 'local', lmstudio: 'local', 'openai-compat': 'local', openrouter: 'openrouter',
};

export function providerFamily(providerId: string | undefined): string {
	if (!providerId) {
		return 'generic';
	}
	return FAMILIES[providerId] ?? providerId;
}

/** "Opus 5.5" from "Claude Opus 5.5": the island has no room for the provider twice. */
export function shortModelName(label: string | undefined): string | undefined {
	if (!label) {
		return undefined;
	}
	const trimmed = label.replace(/^(Claude|Cursor|Codex|Grok|OpenCode)\s+(?=\S)/i, '').trim();
	return trimmed || label;
}

/** "Worked for 1m 5s" (agentTurnStatus.ts formatWorkedDuration). */
export function formatWorked(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) {
		return `Worked for ${Math.max(1, totalSeconds)}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		const rest = minutes % 60;
		return rest ? `Worked for ${hours}h ${rest}m` : `Worked for ${hours}h`;
	}
	return seconds ? `Worked for ${minutes}m ${seconds}s` : `Worked for ${minutes}m`;
}

function basename(path: string): string {
	return path.replace(/\/+$/, '').split('/').pop() || path;
}

/** "Run npm install", "Edit auth.ts", "Open github.com": what an approval asks for. */
export function approvalPrompt(request: IAccessRequestLike): string {
	if (request.preview?.title) {
		return compactStep(request.preview.title, 90);
	}
	const value = request.resource?.value ?? '';
	switch (request.action) {
		case 'shell':
			return compactStep(value ? `Run ${value}` : 'Run a command', 90);
		case 'edit':
			return value ? `Edit ${basename(value)}` : 'Edit a file';
		case 'read':
			return value ? `Read ${basename(value)}` : 'Read a file';
		case 'web':
		case 'network':
		case 'browser': {
			let host = value;
			try {
				host = new URL(value).host || value;
			} catch {
				// not a URL
			}
			return host ? `Open ${host}` : 'Use the network';
		}
		case 'mcp':
			return value ? `Use ${value}` : 'Use a tool';
		case 'git':
			return compactStep(value ? `Run git ${value}` : 'Use git', 90);
		default:
			return compactStep(value ? `${request.action} ${value}` : request.reason || 'Approve an action', 90);
	}
}

function questionPrompt(request: IQuestionRequestLike): string {
	const first = request.questions[0]?.prompt || request.title || 'The agent has a question';
	const more = request.questions.length > 1 ? ` (+${request.questions.length - 1} more)` : '';
	return compactStep(first, 90 - more.length) + more;
}

function workspaceOf(meta: ISessionMetaLike | undefined, session: ISessionSummaryLike | undefined): string | undefined {
	const branch = meta?.worktreeBranch ?? session?.worktreeBranch;
	const folder = meta?.workspaceFolder ? basename(meta.workspaceFolder) : undefined;
	return folder || meta?.workspaceLabel || branch || undefined;
}

/**
 * The chat's state for the Lock Screen and widgets, or undefined for a chat that never ran
 * (a fresh, idle chat has nothing to show).
 */
export function chatView(chatId: string, src: IChatSources, now: number): IAgentChatView | undefined {
	const { meta, thread, session } = src;
	if (!meta && !thread) {
		return undefined;
	}
	const questions = src.questions ?? [];
	const approvals = src.approvals ?? [];
	const inputs = thread?.inputs ?? [];
	const runActive = !!session?.activeRun && RUN_STATUSES.has(session.activeRun.status);
	const running = !!thread?.active || meta?.status === 'running' || runActive;

	const inputKind: AgentInputKind | undefined = inputs[0]?.kind
		?? (questions.length ? 'question' : approvals.length ? 'approval' : meta?.attention);
	const inputPrompt = inputKind === 'question' && questions.length
		? questionPrompt(questions[0])
		: inputKind === 'approval' && approvals.length
			? approvalPrompt(approvals[0])
			: inputKind === 'question' ? 'The agent has a question' : inputKind === 'approval' ? 'Approval needed' : undefined;

	let phase: AgentActivityPhase;
	if (inputKind) {
		phase = 'input';
	} else if (thread?.active?.phase === 'cancelling') {
		phase = 'stopping';
	} else if (running) {
		phase = 'working';
	} else if (thread?.limit && (!thread.last || thread.last.turnId === thread.limit.turnId)) {
		phase = 'limited';
	} else if (thread?.last) {
		phase = thread.last.outcome === 'done' ? 'done' : thread.last.outcome === 'failed' ? 'failed' : 'stopped';
	} else if (meta?.status === 'done') {
		phase = 'done';
	} else if (meta?.status === 'error') {
		phase = 'failed';
	} else if (meta?.status === 'cancelled' || meta?.status === 'interrupted') {
		phase = 'stopped';
	} else {
		return undefined;
	}

	const startedAt = thread?.active?.at ?? session?.activeRun?.startedAt ?? meta?.lastPromptAt ?? thread?.last?.at ?? thread?.limit?.at ?? meta?.updatedAt ?? now;
	const ended = !ACTIVE_PHASES.has(phase);
	const endedAt = ended ? Math.max(startedAt, thread?.last?.at ?? thread?.limit?.at ?? meta?.updatedAt ?? now) : undefined;
	const tasks = src.tasks ?? [];
	const liveTasks = tasks.filter(task => LIVE_TASK_STATES.has(task.state));

	let step: string;
	switch (phase) {
		case 'input':
			step = inputKind === 'question' ? 'Waiting for your answer' : 'Waiting for approval';
			break;
		case 'stopping':
			step = 'Stopping';
			break;
		case 'working':
			step = src.step?.step
				?? (thread?.active?.kind === 'notification' ? 'Reading subagent reports' : undefined)
				?? (liveTasks.length ? (liveTasks.length === 1 ? 'Waiting for 1 subagent' : `Waiting for ${liveTasks.length} subagents`) : undefined)
				?? (thread?.blocked ? compactStep(thread.blocked) : undefined)
				?? 'Working';
			break;
		case 'limited':
			step = compactStep(thread?.limit?.message || 'Usage limit reached', 90);
			break;
		case 'failed':
			step = compactStep(thread?.last?.error || 'Failed', 90);
			break;
		case 'stopped':
			step = thread?.last?.outcome === 'interrupted' || meta?.status === 'interrupted' ? 'Interrupted' : 'Stopped';
			break;
		default:
			step = formatWorked((endedAt ?? now) - startedAt);
	}

	return {
		chatId,
		title: compactStep(meta?.title || thread?.title || meta?.preview || 'New chat', 80),
		provider: providerFamily(src.provider ?? providerFromRef(thread?.active?.prompt?.modelRef ?? thread?.modelRef ?? session?.activeRun?.providerRef ?? session?.providerRef)),
		phase,
		step,
		startedAt,
		...(endedAt !== undefined ? { endedAt } : {}),
		filesChanged: Math.max(src.filesChanged ?? 0, src.step?.files.length ?? 0),
		queued: (thread?.queue ?? []).filter(item => !item.held && (!item.kind || item.kind === 'prompt')).length,
		subagents: liveTasks.length,
		...(inputKind ? { inputKind } : {}),
		...(inputPrompt ? { inputPrompt } : {}),
		...(shortModelName(src.modelLabel ?? thread?.modelLabel ?? meta?.model) ? { model: shortModelName(src.modelLabel ?? thread?.modelLabel ?? meta?.model) } : {}),
		...(workspaceOf(meta, session) ? { workspace: workspaceOf(meta, session) } : {}),
		...(phase === 'limited' && thread?.limit?.resetAt ? { limitResetAt: thread.limit.resetAt } : {}),
		updatedAt: now,
	};
}

/** Which chats deserve a Live Activity first: blocked on the user, then stopping, then the newest work. */
export function rankActive(views: readonly IAgentChatView[]): IAgentChatView[] {
	const weight = (view: IAgentChatView) => view.phase === 'input' ? 0 : view.phase === 'stopping' ? 1 : 2;
	return views
		.filter(view => ACTIVE_PHASES.has(view.phase))
		.sort((a, b) => weight(a) - weight(b) || b.startedAt - a.startedAt || (a.chatId < b.chatId ? -1 : 1));
}

/** The content state ActivityKit receives (seconds, no undefined keys). */
export function activityContentState(view: IAgentChatView, others: number): IAgentActivityContentState {
	return {
		phase: view.phase,
		title: view.title,
		step: view.step,
		startedAt: toSeconds(view.startedAt),
		...(view.endedAt !== undefined ? { endedAt: toSeconds(view.endedAt) } : {}),
		filesChanged: view.filesChanged,
		queued: view.queued,
		subagents: view.subagents,
		...(view.inputKind ? { inputKind: view.inputKind } : {}),
		...(view.inputPrompt ? { inputPrompt: view.inputPrompt } : {}),
		...(view.model ? { model: view.model } : {}),
		others: Math.max(0, others),
		...(view.limitResetAt ? { limitResetAt: toSeconds(view.limitResetAt) } : {}),
		updatedAt: toSeconds(view.updatedAt),
	};
}

/** `volt://chat/<id>`: the chat screen (expo-router route `chat/[id]`). */
export function chatUrl(chatId: string, scheme = 'volt', action?: 'stop'): string {
	return `${scheme}://chat/${encodeURIComponent(chatId)}${action ? `?action=${action}` : ''}`;
}

/** Parses a widget or activity link back into the chat and action, for the app's link handler. */
export function parseChatUrl(url: string): { readonly chatId: string; readonly action?: 'stop' } | undefined {
	const match = /^[a-z][a-z0-9+.-]*:\/\/\/?chat\/([^?#/]+)(?:\?([^#]*))?/i.exec(url);
	if (!match) {
		return undefined;
	}
	let chatId: string;
	try {
		chatId = decodeURIComponent(match[1]);
	} catch {
		return undefined;
	}
	const action = new URLSearchParams(match[2] ?? '').get('action');
	return { chatId, ...(action === 'stop' ? { action } : {}) };
}
