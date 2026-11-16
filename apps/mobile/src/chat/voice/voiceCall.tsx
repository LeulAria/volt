/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoiceSettings, IVoiceTurn, VoltClient } from '@volt/client-core';
import { router } from 'expo-router';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useOptionalClient } from '../../state/client';
import { haptic } from '../../ui/core';
import { ensureMicPermission, type IVoiceEngineHandle, VoiceEngine, type VoiceEngineMessage } from './VoiceEngine';

export type VoicePhase = 'idle' | 'connecting' | 'live' | 'failed';

export interface IVoiceCallState {
	readonly phase: VoicePhase;
	readonly callId?: string;
	/** The chat the call works in (undefined until a new chat's first task starts one). */
	readonly chatId?: string;
	/** Where it was started: a chat id, or `new` for the new-chat screen. */
	readonly originKey?: string;
	readonly muted: boolean;
	readonly settings: IVoiceSettings;
	readonly connectedAt?: number;
	readonly turns: readonly IVoiceTurn[];
	readonly error?: string;
	readonly activity?: 'listening' | 'thinking' | 'speaking';
}

export interface IVoiceCall {
	readonly state: IVoiceCallState;
	readonly active: boolean;
	start(options: { readonly chatId?: string; readonly projectId?: string; readonly originKey: string }): Promise<void>;
	hangUp(): void;
	setMuted(muted: boolean): void;
	setSettings(next: Partial<IVoiceSettings>): void;
	dismissFailure(): void;
	/** The line's loudness 0..1, ~12 times a second while the call is up. */
	onLevel(listener: (level: number) => void): () => void;
}

const IDLE: IVoiceCallState = { phase: 'idle', muted: false, settings: { voice: 'ara', speed: 1, language: 'auto' }, turns: [] };
const HEARD_EVERY_MS = 10_000;

const VoiceCallContext = createContext<IVoiceCall | undefined>(undefined);

/**
 * The phone's voice call (one at a time, like the desktop's): the agent server mints the call and
 * runs the voice's tools (`voice.*`); the hidden engine page streams the audio. Mounted at the
 * app root so a call keeps going while the user moves between screens.
 */
export function VoiceCallProvider({ children }: { readonly children: ReactNode }) {
	const client = useOptionalClient();
	const [state, setState] = useState<IVoiceCallState>(IDLE);
	const stateRef = useRef(state);
	stateRef.current = state;
	const engine = useRef<IVoiceEngineHandle>(null);
	const levelListeners = useRef(new Set<(level: number) => void>());
	const heard = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const patch = useCallback((next: Partial<IVoiceCallState>) => setState(prev => {
		const merged = { ...prev, ...next };
		stateRef.current = merged;
		return merged;
	}), []);

	const finish = useCallback((client: VoltClient | undefined, error?: string) => {
		const current = stateRef.current;
		if (heard.current) {
			clearInterval(heard.current);
			heard.current = undefined;
		}
		if (current.callId && client) {
			client.voiceReport('end', current.callId, error ? 'failed' : 'ended', error);
		}
		patch(error ? { phase: 'failed', error, activity: undefined } : { ...IDLE, settings: current.settings });
	}, [patch]);

	// The server's notes: what the chat's agent came back with, the chat a first task started, a server-side end.
	useEffect(() => client?.onVoiceEvent(event => {
		const current = stateRef.current;
		if (event.callId !== current.callId || (current.phase !== 'connecting' && current.phase !== 'live')) {
			return;
		}
		if (event.kind === 'note') {
			engine.current?.send({ type: 'note', text: event.text });
		} else if (event.kind === 'chat') {
			patch({ chatId: event.chatId });
			// The call's first task started a chat: open it, as sending from that composer would.
			if (current.originKey === 'new') {
				router.dismiss();
				router.push({ pathname: '/chat/[id]', params: { id: event.chatId } });
			} else {
				router.replace({ pathname: '/chat/[id]', params: { id: event.chatId } });
			}
		} else if (event.kind === 'ended') {
			engine.current?.send({ type: 'hangup' });
		}
	}), [client, patch]);

	const onEngine = useCallback((message: VoiceEngineMessage) => {
		const current = stateRef.current;
		const callId = current.callId;
		if (!client || !callId) {
			return;
		}
		switch (message.type) {
			case 'ready':
				client.voiceReport('connected', callId);
				patch({ phase: 'live', connectedAt: Date.now(), activity: 'listening' });
				heard.current = setInterval(() => client.voiceReport('heard', callId), HEARD_EVERY_MS);
				break;
			case 'state':
				patch({ activity: message.state as IVoiceCallState['activity'] });
				break;
			case 'level':
				for (const listener of levelListeners.current) {
					listener(Number(message.level) || 0);
				}
				break;
			case 'userTranscript':
			case 'assistantTranscript': {
				const text = String(message.text ?? '').trim();
				if (!text || (message.type === 'userTranscript' && !message.final)) {
					break;
				}
				const role = message.type === 'userTranscript' ? 'user' : 'assistant';
				const itemId = String(message.itemId ?? '');
				patch({ turns: [...current.turns, { id: itemId || `${Date.now()}`, role, text, at: Date.now() }] });
				client.voiceReport('turn', callId, role, text, itemId || undefined);
				break;
			}
			case 'functionCall': {
				const toolCallId = String(message.callId ?? '');
				void client.voiceTool(callId, String(message.name ?? ''), String(message.arguments ?? '{}')).then(
					result => engine.current?.send({ type: 'toolResult', callId: toolCallId, output: result.output, respond: result.respond, instructions: result.instructions, end: result.end }),
					() => engine.current?.send({ type: 'toolResult', callId: toolCallId, output: { error: 'the tool failed on the caller\'s device' }, respond: true }),
				);
				break;
			}
			case 'error':
				if (message.fatal) {
					finish(client, String(message.message ?? 'The voice chat stopped.'));
				}
				break;
			case 'ended':
				if (stateRef.current.phase === 'connecting' || stateRef.current.phase === 'live') {
					finish(client);
				}
				break;
		}
	}, [client, finish, patch]);

	const start = useCallback(async (options: { readonly chatId?: string; readonly projectId?: string; readonly originKey: string }) => {
		const current = stateRef.current;
		if (!client || current.phase === 'connecting' || current.phase === 'live') {
			return;
		}
		haptic.medium();
		patch({ ...IDLE, settings: current.settings, phase: 'connecting', chatId: options.chatId, originKey: options.originKey, callId: undefined });
		if (!await ensureMicPermission()) {
			patch({ phase: 'failed', error: 'Volt is not allowed to use the microphone. Allow it in Settings.' });
			return;
		}
		try {
			const started = await client.voiceStart({ ...(options.chatId ? { chatId: options.chatId } : {}), ...(options.projectId ? { projectId: options.projectId } : {}) });
			patch({ callId: started.callId, settings: started.settings });
			stateRef.current = { ...stateRef.current, callId: started.callId };
			engine.current?.send({ type: 'start', session: started.session, sessionUpdate: started.sessionUpdate, greeting: started.greeting });
		} catch (err) {
			patch({ phase: 'failed', error: err instanceof Error ? err.message.replace(/^[A-Za-z]+: /, '') : String(err) });
		}
	}, [client, patch]);

	const hangUp = useCallback(() => {
		haptic.medium();
		engine.current?.send({ type: 'hangup' });
		if (stateRef.current.phase === 'connecting' && !stateRef.current.callId) {
			patch({ ...IDLE, settings: stateRef.current.settings });
		}
	}, [patch]);

	const setMuted = useCallback((muted: boolean) => {
		haptic.selection();
		engine.current?.send({ type: 'mute', muted });
		patch({ muted });
	}, [patch]);

	const setSettings = useCallback((next: Partial<IVoiceSettings>) => {
		const current = stateRef.current;
		patch({ settings: { ...current.settings, ...next } });
		if (client && current.callId && current.phase === 'live') {
			void client.voiceSettings(current.callId, next).then(sessionUpdate => engine.current?.send({ type: 'update', sessionUpdate }), () => undefined);
		}
	}, [client, patch]);

	const dismissFailure = useCallback(() => patch({ ...IDLE, settings: stateRef.current.settings }), [patch]);

	const value = useMemo<IVoiceCall>(() => ({
		state,
		active: state.phase === 'connecting' || state.phase === 'live',
		start,
		hangUp,
		setMuted,
		setSettings,
		dismissFailure,
		onLevel: listener => {
			levelListeners.current.add(listener);
			return () => levelListeners.current.delete(listener);
		},
	}), [state, start, hangUp, setMuted, setSettings, dismissFailure]);

	const running = state.phase === 'connecting' || state.phase === 'live';
	return (
		<VoiceCallContext.Provider value={value}>
			{children}
			{/* Mounted only for a call: the microphone and the socket go with it. */}
			{running ? <VoiceEngine ref={engine} onMessage={onEngine} /> : null}
		</VoiceCallContext.Provider>
	);
}

export function useVoiceCall(): IVoiceCall | undefined {
	return useContext(VoiceCallContext);
}
