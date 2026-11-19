/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVoltVoiceCall, IVoltVoiceTurn, providerSpeed, VOLT_VOICE_PROVIDER_INFO, VoltVoiceProvider } from '../../../../platform/voltVoiceChat/common/voltVoiceChat.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService, IOrchPrompt } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { IRealtimeSessionConfig } from './realtimeProtocol.js';
import { ISearchable, recentLines, searchConversations, SEND_TASK_LIMIT, spokenAnswer, VOICE_TOOLS, voiceInstructions, workLandedNote } from './voiceAgent.js';

export const VOICE_SOURCE_TITLE = 'Voice call';

const SAVE_DELAY_MS = 1_000;

const SENT_INSTRUCTIONS = 'The job was sent to the agent. Say you sent it in one short clause of eight words or fewer, never that it started or is done. If the request was broad, ask one sharpening question; otherwise keep talking with a natural question or a suggestion. Do not stay_silent.';

/** Who wrote a prompt: a voice call (`id` is the call). */
export interface IVoiceSource {
	readonly kind: 'voice';
	readonly id: string;
	readonly title: string;
}

export interface IVoiceCallSettings {
	readonly voice: string;
	readonly speed: number;
	/** `auto`, or a language code such as `de` or `pt-BR`. */
	readonly language: string;
}

/** What a tool call comes back with. */
export interface IVoiceToolResult {
	readonly output: unknown;
	/** Ask for a spoken answer after it (with `instructions` for that one answer). */
	readonly respond: boolean;
	readonly instructions?: string;
	/** `end_the_call`: hang up once the goodbye has been spoken. */
	readonly end?: boolean;
}

/** Where the call runs: the window (desktop, browser) or the agent server for a phone. */
export interface IVoiceBrainHost {
	/** A note for the voice to say out loud (the chat's agent finished, or needs the user). */
	speak(note: string): void;
	/** The call works in a new chat now (its first task started one). */
	onChat(chatId: string): void;
	/** The call's record changed (turns, chats, timing). */
	onRecord(record: IVoltVoiceCall): void;
	save(record: IVoltVoiceCall): Promise<void>;
	/** The chat's earlier calls (recent context and search). */
	earlierCalls(chatId: string): Promise<readonly IVoltVoiceCall[]>;
	/** Starts a chat with the call's first task (the composer it was started from); its id, or undefined. */
	startChat(text: string, source: IVoiceSource): Promise<string | undefined>;
	/** Sends to an idle chat the user has on screen, so it draws there at once. False: not on screen. */
	submitOnScreen?(chatId: string, text: string, source: IVoiceSource): boolean;
}

export interface IVoiceBrainServices {
	readonly orchestrator: IAgentOrchestratorService;
	readonly runtime: IAgentRuntimeService;
	readonly history: IAgentHistoryService;
	readonly hostTools: IVoltHostToolService;
	readonly logService: ILogService;
}

interface IOpenErrand {
	readonly request: string;
	readonly turnId?: string;
	readonly at: number;
}

/**
 * One call's voice agent, apart from its audio (shared by the window and the agent server): the
 * instructions and tools it starts with, what each tool does in Volt (send_task to the chat it
 * works in, search, read-only peeks), the work_landed notes when the chat's agent finishes, and
 * the call's saved record.
 */
export class VoiceCallBrain extends Disposable {

	private _record: IVoltVoiceCall;
	private _chatId: string | undefined;
	private errands: IOpenErrand[] = [];
	private lastSeenTurn: string | undefined;
	private watchedTurn: string | undefined;
	private _userSpokeSinceReply = false;
	private readonly saveScheduler = this._register(new RunOnceScheduler(() => void this.saveNow(), SAVE_DELAY_MS));

	constructor(
		callId: string,
		chatId: string | undefined,
		provider: VoltVoiceProvider,
		voice: string,
		private readonly host: IVoiceBrainHost,
		private readonly services: IVoiceBrainServices,
	) {
		super();
		this._chatId = chatId;
		const thread = chatId ? services.orchestrator.getThread(chatId) : undefined;
		this.lastSeenTurn = thread?.last?.turnId;
		this.watchedTurn = thread?.active?.id;
		const now = Date.now();
		this._record = {
			id: callId, startedAt: now, status: 'ongoing', provider, voice, originChatId: chatId,
			chatIds: chatId ? [chatId] : [], turns: [], lastHeardAt: now,
			anchors: chatId && this.lastSeenTurn ? { [chatId]: { turnId: this.lastSeenTurn } } : {},
		};
		this._register(services.orchestrator.onDidChange(change => {
			if (this._chatId && change.threads.includes(this._chatId)) {
				this.checkChat(this._chatId);
			}
		}));
		this.saveScheduler.schedule();
	}

	get record(): IVoltVoiceCall {
		return this._record;
	}

	get chatId(): string | undefined {
		return this._chatId;
	}

	/** The caller spoke after the voice's last answer. */
	get userSpokeSinceReply(): boolean {
		return this._userSpokeSinceReply;
	}

	//#region Record

	connected(): void {
		const now = Date.now();
		this.patch({ connectedAt: now, lastHeardAt: now });
	}

	heard(): void {
		this.patch({ lastHeardAt: Date.now() });
	}

	addTurn(turn: Omit<IVoltVoiceTurn, 'id' | 'at'> & { readonly id?: string }): void {
		const turns = [...this._record.turns];
		const previous = turns.at(-1);
		if (turn.role === 'user') {
			this._userSpokeSinceReply = true;
		} else if (turn.role === 'assistant') {
			this._userSpokeSinceReply = false;
		}
		// A caller turn that extends the one before (the transcriber split it) joins it.
		if (turn.role === 'user' && previous?.role === 'user' && Date.now() - previous.at < 4000) {
			turns[turns.length - 1] = { ...previous, text: `${previous.text} ${turn.text}`.trim() };
		} else {
			turns.push({ id: turn.id ?? generateUuid(), role: turn.role, text: turn.text, at: Date.now(), ...(turn.chatId ? { chatId: turn.chatId } : {}) });
		}
		this.patch({ turns, lastHeardAt: Date.now() });
	}

	/** Ends the record (the call hung up or failed) and saves it now. */
	async end(status: 'ended' | 'failed', error?: string): Promise<void> {
		if (this._record.status !== 'ongoing') {
			return;
		}
		const now = Date.now();
		this.patch({ status, endedAt: now, lastHeardAt: now, ...(error ? { error } : {}) });
		this.saveScheduler.cancel();
		await this.saveNow();
	}

	private patch(patch: Partial<IVoltVoiceCall>): void {
		this._record = { ...this._record, ...patch };
		this.host.onRecord(this._record);
		this.saveScheduler.schedule();
	}

	private async saveNow(): Promise<void> {
		try {
			await this.host.save(this._record);
		} catch (err) {
			this.services.logService.warn('[volt voice] could not save the call', err);
		}
	}

	//#endregion

	//#region Session

	async sessionConfig(provider: VoltVoiceProvider, settings: IVoiceCallSettings, surface: 'desk' | 'web' | 'phone', languageLabel: (code: string) => string): Promise<IRealtimeSessionConfig> {
		const chatId = this._chatId;
		const meta = chatId ? this.services.history.get(chatId) : undefined;
		const info = VOLT_VOICE_PROVIDER_INFO[provider];
		return {
			provider,
			voice: info.voices.includes(settings.voice) ? settings.voice : info.defaultVoice,
			speed: providerSpeed(provider, settings.speed),
			language: settings.language === 'auto' ? undefined : settings.language,
			tools: VOICE_TOOLS,
			instructions: voiceInstructions({
				chatTitle: meta?.title,
				projectName: meta?.workspaceLabel || meta?.workspaceFolder?.split(/[\\/]/).filter(Boolean).at(-1),
				language: settings.language === 'auto' ? undefined : languageLabel(settings.language),
				recent: chatId ? await this.recentConversation(chatId) : undefined,
				now: new Date(),
				surface,
			}),
		};
	}

	//#endregion

	//#region The chat

	private checkChat(chatId: string): void {
		const thread = this.services.orchestrator.getThread(chatId);
		if (!thread) {
			return;
		}
		if (thread.active && thread.active.id !== this.watchedTurn) {
			this.watchedTurn = thread.active.id;
			// A pending new-chat errand is the first turn that starts.
			const pending = this.errands.find(errand => !errand.turnId);
			if (pending) {
				this.errands = this.errands.map(errand => errand === pending ? { ...errand, turnId: thread.active!.id } : errand);
			}
			// A chat the call started: its card follows the reply to that first task.
			if (!this._record.anchors?.[chatId]) {
				this.patch({ anchors: { ...this._record.anchors, [chatId]: { turnId: thread.active.id } } });
			}
		}
		const last = thread.last;
		if (!thread.active && last && last.turnId !== this.lastSeenTurn) {
			this.lastSeenTurn = last.turnId;
			const errand = this.errands.find(candidate => candidate.turnId === last.turnId) ?? (this.errands.length === 1 && !this.errands[0].turnId ? this.errands[0] : undefined);
			this.errands = this.errands.filter(candidate => candidate !== errand);
			const typed = !errand && last.kind === 'prompt';
			if (!errand && !typed) {
				return;
			}
			const outcome = thread.inputs.length ? 'needs-user' : last.outcome === 'done' ? 'done' : last.outcome === 'failed' ? 'failed' : 'stopped';
			void this.landed(chatId, last.turnId, outcome, last.error, errand?.request, typed);
		} else if (thread.active && thread.inputs.length && !this.errands.some(errand => errand.request === '\u0000needs')) {
			// Blocked on a question or an approval while the call runs: the voice says so once.
			this.errands.push({ request: '\u0000needs', turnId: thread.active.id, at: Date.now() });
			this.host.speak(workLandedNote(undefined, 'needs-user', undefined, false));
		}
	}

	/** Tells the voice what the turn came back with (its reply from the chat's saved transcript). */
	private async landed(chatId: string, turnId: string, outcome: 'done' | 'needs-user' | 'stopped' | 'failed', error: string | undefined, request: string | undefined, typed: boolean): Promise<void> {
		const reply = outcome === 'done' ? await this.replyOf(chatId, turnId) : undefined;
		if (this._store.isDisposed || this._chatId !== chatId) {
			return;
		}
		const asked = request ?? (typed ? reply?.prompt : undefined);
		this.addTurn({ role: 'note', text: outcome === 'done' ? 'The agent finished.' : outcome === 'needs-user' ? 'The agent needs you in the chat.' : outcome === 'failed' ? 'The work failed.' : 'The work was stopped.', chatId });
		this.host.speak(workLandedNote(asked, outcome, outcome === 'done' ? (reply?.text ? spokenAnswer(reply.text) : undefined) : error, typed));
	}

	/** A turn's prompt and final reply, from the saved transcript (the reply may land a moment after the turn ends). */
	private async replyOf(chatId: string, turnId: string): Promise<{ readonly prompt?: string; readonly text?: string } | undefined> {
		for (let attempt = 0; attempt < 6; attempt++) {
			try {
				const turns = (await this.services.history.open(chatId).load()).turns;
				const turn = turns.find(candidate => candidate.id === turnId) ?? turns.at(-1);
				if (turn?.assistant?.final && turn.assistant.text.trim()) {
					return { prompt: turn.user.text, text: turn.assistant.text.trim() };
				}
				if (attempt === 5) {
					return { prompt: turn?.user.text, text: turn?.assistant?.text.trim() || this.lastReply(chatId) };
				}
			} catch {
				// Read again.
			}
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		return { text: this.lastReply(chatId) };
	}

	private lastReply(chatId: string): string | undefined {
		const messages = this.services.runtime.getOrCreateSession(chatId).messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'assistant' && messages[i].content.trim()) {
				return messages[i].content.trim();
			}
			if (messages[i].role === 'user') {
				break;
			}
		}
		return undefined;
	}

	private async chatLines(chatId: string): Promise<{ readonly speaker: 'User' | 'Volt'; readonly text: string; readonly at: number; readonly id: string }[]> {
		try {
			const turns = (await this.services.history.open(chatId).load()).turns;
			const lines: { speaker: 'User' | 'Volt'; text: string; at: number; id: string }[] = [];
			for (const turn of turns.slice(-200)) {
				lines.push({ speaker: 'User', text: turn.user.text, at: turn.user.at, id: `chat-${turn.id}-u` });
				if (turn.assistant?.text) {
					lines.push({ speaker: 'Volt', text: turn.assistant.text, at: turn.assistant.at, id: `chat-${turn.id}-a` });
				}
			}
			return lines;
		} catch {
			return [];
		}
	}

	private async recentConversation(chatId: string): Promise<string[]> {
		const lines = (await this.chatLines(chatId)).slice(-24);
		const earlier = (await this.host.earlierCalls(chatId)).filter(call => call.id !== this._record.id).slice(-2)
			.flatMap(call => call.turns.filter(turn => turn.role !== 'note').slice(-6).map(turn => ({ speaker: turn.role === 'user' ? 'User' as const : 'Volt' as const, text: `(on a voice call) ${turn.text}`, at: turn.at })));
		return recentLines([...earlier, ...lines].sort((a, b) => a.at - b.at));
	}

	//#endregion

	//#region Tools

	/** Runs one of the voice's tools. `end_the_call` and `stay_silent` only report what the line should do. */
	async runTool(name: string, rawArgs: string): Promise<IVoiceToolResult> {
		let args: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(rawArgs || '{}');
			args = parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			// Treated as no arguments.
		}
		try {
			switch (name) {
				case 'send_task': {
					const result = await this.sendTask(typeof args.request === 'string' ? args.request : '');
					return { output: result.output, respond: true, instructions: result.instructions };
				}
				case 'search_conversations':
					return { output: await this.search(args), respond: true };
				case 'peek_changes':
					return { output: await this.peek('worktree_status', {}, typeof args.file === 'string' ? args.file : undefined, 'No file changes recorded for this chat.'), respond: true };
				case 'peek_runs':
					return { output: await this.peek('thread_read', { limit: 3, max_chars: 6000 }, typeof args.query === 'string' ? args.query : undefined, 'No commands recorded in this chat yet.'), respond: true };
				case 'peek_agents':
					return { output: await this.peek('thread_list', typeof args.agent === 'string' && args.agent ? { query: args.agent } : {}, undefined, 'No other chats.'), respond: true };
				case 'stay_silent':
					return this._userSpokeSinceReply ? { output: { error: 'They just talked to you. Answer them.' }, respond: true } : { output: {}, respond: false };
				case 'end_the_call':
					return { output: {}, respond: false, end: true };
				default:
					return { output: { error: `unknown tool ${name}` }, respond: true };
			}
		} catch (err) {
			this.services.logService.warn(`[volt voice] ${name} failed`, err);
			return { output: { error: 'the tool failed on the caller\'s device' }, respond: true };
		}
	}

	private async sendTask(request: string): Promise<{ readonly output: unknown; readonly instructions?: string }> {
		const text = request.trim();
		if (!text) {
			return { output: { error: 'Refused: the request was empty.' } };
		}
		if (text.length > SEND_TASK_LIMIT) {
			return { output: { error: `The task was not sent: request exceeds ${SEND_TASK_LIMIT} characters. Reformulate it within the limit while keeping every constraint.` } };
		}
		if (this.errands.some(errand => errand.request === text)) {
			return { output: { receipt: 'already under way' }, instructions: 'That exact request is already with the agent. Say where it stands in one short line; nothing new was sent.' };
		}
		const source: IVoiceSource = { kind: 'voice', id: this._record.id, title: VOICE_SOURCE_TITLE };
		const { orchestrator, runtime } = this.services;
		let chatId = this._chatId;
		if (!chatId) {
			// A new chat's composer: the first task starts the chat, as typing it would.
			this.errands.push({ request: text, at: Date.now() });
			this.lastSeenTurn = undefined;
			this.watchedTurn = undefined;
			chatId = await this.host.startChat(text, source);
			if (!chatId) {
				this.errands.pop();
				return { output: { relay: 'unreachable', spoken: 'There is no chat open to send it to. Say that, and ask them to open a chat.' } };
			}
			this.reachChat(chatId);
			this.checkChat(chatId);
			return { output: { receipt: 'under way' }, instructions: SENT_INSTRUCTIONS };
		}
		const thread = orchestrator.getThread(chatId);
		if (thread?.inputs.length) {
			return { output: { relay: 'refused', spoken: 'The agent needs the person in the chat. Say that.' } };
		}
		const turnId = generateUuid();
		const prompt: IOrchPrompt = { text, display: { text }, host: { fromThread: source } };
		const running = !!thread?.active && thread.active.phase === 'running';
		if (running && (thread!.active!.steerable || runtime.canSteer(chatId))) {
			// Cursor's voice steers a running turn rather than queueing behind it.
			const result = await orchestrator.submit(chatId, prompt, 'now', turnId);
			if (result.outcome === 'rejected') {
				return { output: { error: result.reason ?? 'The chat refused the message.' } };
			}
			this.errands.push({ request: text, turnId: thread!.active!.id, at: Date.now() });
			return { output: { receipt: 'under way', steered: true }, instructions: SENT_INSTRUCTIONS };
		}
		if (!running && this.host.submitOnScreen?.(chatId, text, source)) {
			this.errands.push({ request: text, at: Date.now() });
			return { output: { receipt: 'under way' }, instructions: SENT_INSTRUCTIONS };
		}
		const result = await orchestrator.submit(chatId, prompt, 'auto', turnId);
		if (result.outcome === 'rejected') {
			return { output: { error: result.reason ?? 'The chat refused the message.' } };
		}
		this.errands.push({ request: text, turnId, at: Date.now() });
		if (result.outcome === 'queued') {
			return { output: { receipt: 'queued behind the current work', behind: 'work that was already running' }, instructions: 'This request is waiting behind work already running. It has not started. Say that in your own words, in one short line.' };
		}
		return { output: { receipt: 'under way' }, instructions: SENT_INSTRUCTIONS };
	}

	/** The call now works in `chatId` (a new chat its first task started); its card is placed once that task's turn starts. */
	private reachChat(chatId: string): void {
		this._chatId = chatId;
		if (!this._record.chatIds.includes(chatId)) {
			this.patch({ chatIds: [...this._record.chatIds, chatId] });
			void this.saveNow();
		}
		this.host.onChat(chatId);
	}

	private async search(args: Record<string, unknown>): Promise<unknown> {
		const chatId = this._chatId;
		const scope = args.scope === 'this-chat' || args.scope === 'earlier' ? args.scope : 'everything';
		const items: ISearchable[] = [];
		if (chatId && scope !== 'earlier') {
			for (const line of await this.chatLines(chatId)) {
				items.push({ id: line.id, where: 'this chat', writer: line.speaker === 'User' ? 'them' : 'you', text: line.text, at: line.at });
			}
		}
		if (chatId && scope !== 'this-chat') {
			for (const call of await this.host.earlierCalls(chatId)) {
				if (call.id === this._record.id) {
					continue;
				}
				for (const turn of call.turns) {
					if (turn.role !== 'note') {
						items.push({ id: `call-${call.id}-${turn.id}`, where: 'an earlier call', writer: turn.role === 'user' ? 'them' : 'you', text: turn.text, at: turn.at });
					}
				}
			}
		}
		if (typeof args.id === 'string' && args.id) {
			const hit = items.find(item => item.id === args.id);
			return hit ? { id: hit.id, where: hit.where, writer: hit.writer, text: hit.text.slice(0, 2000) } : { error: 'No message has that id.' };
		}
		return searchConversations(items, typeof args.query === 'string' ? args.query : '', Date.now());
	}

	/** A read-only look through Volt's own thread tools, as the chat itself would ask. */
	private async peek(tool: string, args: Record<string, unknown>, filter: string | undefined, empty: string): Promise<string> {
		const chatId = this._chatId;
		const { hostTools } = this.services;
		if (!chatId) {
			if (tool !== 'thread_list') {
				return 'No chat has started on this call yet, so there is nothing to read.';
			}
			const result = await hostTools.invokeTool('thread_list', args, { source: 'native', external: { grantId: 'volt-voice', clientId: 'volt-voice-call', name: VOICE_SOURCE_TITLE, scopes: ['read'] } });
			return (result.error ? `Could not read it: ${result.error}` : result.text ?? '').slice(0, 2000) || empty;
		}
		const result = await hostTools.invokeTool(tool, args, { sessionId: chatId, source: 'native' });
		let text = result.error ? `Could not read it: ${result.error}` : (result.text ?? '').trim();
		if (filter && text) {
			const needle = filter.toLowerCase();
			const lines = text.split('\n').filter(line => line.toLowerCase().includes(needle));
			text = lines.length ? lines.join('\n') : `Nothing about "${filter}".`;
		}
		return (text || empty).slice(0, 2000);
	}

	//#endregion
}
