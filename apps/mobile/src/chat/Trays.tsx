/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clockTime, firstLine, type IAccessRequest, type IOrchThread, type IQuestionRequest, RADIUS } from '@volt/client-core';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useClient } from '../state/client';
import { FONT, useTheme } from '../theme/theme';
import { Button, haptic, Icon, IconButton, T, Tap } from '../ui/core';

const ACTION_TITLES: Record<string, string> = {
	shell: 'Run a command', edit: 'Edit a file', read: 'Read a file', search: 'Search the project', web: 'Open a web page', network: 'Use the network',
	mcp: 'Use a tool', browser: 'Control the browser', subagent: 'Start a subagent', git: 'Run git', question: 'Ask you',
};

function trayStyle(p: ReturnType<typeof useTheme>['p'], accent: string) {
	return {
		backgroundColor: p.raised, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: `${accent}77`, padding: 14,
		shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 5,
	};
}

export function ApprovalCard({ request }: { readonly request: IAccessRequest }) {
	const { p } = useTheme();
	const client = useClient();
	const [busy, setBusy] = useState<string | undefined>();
	const risky = request.risk === 'high' || request.risk === 'critical';
	const accent = risky ? p.danger : p.warning;
	const detail = request.preview?.detail ?? request.resource?.value;
	const answer = async (id: string, effect: 'allow' | 'deny', scope: 'once' | 'always') => {
		setBusy(id);
		if (effect === 'allow') {
			haptic.success();
		} else {
			haptic.warning();
		}
		await client.respondToApproval(request.id, effect, scope);
		setBusy(undefined);
	};
	return (
		<Animated.View entering={FadeInDown.duration(220)} exiting={FadeOutDown.duration(160)} style={trayStyle(p, accent)}>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
				<Icon name="shieldAlert" size={14} color={accent} />
				<T variant="caption" weight="700" color={accent} style={{ letterSpacing: 0.8 }}>APPROVAL NEEDED</T>
				{request.risk && request.risk !== 'safe' ? <T variant="caption" color={risky ? p.danger : p.fgTertiary}>{`· ${request.risk} risk`}</T> : null}
			</View>
			<T variant="callout" weight="600" style={{ marginTop: 6 }}>{request.preview?.title ?? ACTION_TITLES[request.action] ?? `Use ${request.action}`}</T>
			{detail ? (
				<ScrollView style={{ maxHeight: 120, marginTop: 8, borderRadius: RADIUS.md, backgroundColor: p.codeBg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }} contentContainerStyle={{ padding: 10 }}>
					<Text selectable style={{ fontFamily: FONT.mono, fontSize: 12, lineHeight: 18, color: p.fg }}>{detail}</Text>
				</ScrollView>
			) : null}
			{request.reason ? <T variant="footnote" color={p.fgTertiary} style={{ marginTop: 6 }}>{request.reason}</T> : null}
			<View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
				<Button label="Allow once" variant="primary" size="sm" busy={busy === 'once'} onPress={() => void answer('once', 'allow', 'once')} flex />
				<Button label="Always" size="sm" busy={busy === 'always'} onPress={() => void answer('always', 'allow', 'always')} />
				<Button label="Deny" variant="danger" size="sm" busy={busy === 'deny'} onPress={() => void answer('deny', 'deny', 'once')} />
			</View>
		</Animated.View>
	);
}

export function QuestionCard({ request }: { readonly request: IQuestionRequest }) {
	const { p } = useTheme();
	const client = useClient();
	const [index, setIndex] = useState(0);
	const [picked, setPicked] = useState<Record<string, readonly string[]>>({});
	const [other, setOther] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const question = request.questions[index];
	if (!question) {
		return null;
	}
	const chosen = picked[question.id] ?? [];
	const last = index === request.questions.length - 1;
	const answered = chosen.length > 0 || !!other[question.id]?.trim();
	const submit = async () => {
		setBusy(true);
		haptic.success();
		await client.answerQuestions(request.id, {
			outcome: 'answered',
			answers: request.questions.map(q => ({ questionId: q.id, optionIds: picked[q.id] ?? [], ...(other[q.id]?.trim() ? { other: other[q.id].trim() } : {}) })),
		});
		setBusy(false);
	};
	return (
		<Animated.View entering={FadeInDown.duration(220)} exiting={FadeOutDown.duration(160)} style={trayStyle(p, p.violet)}>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
				<Icon name="help" size={14} color={p.violet} />
				<T variant="caption" weight="700" color={p.violet} style={{ letterSpacing: 0.8, flex: 1 }} numberOfLines={1}>{(request.title ?? 'Question').toUpperCase()}</T>
				{request.questions.length > 1 ? <T variant="caption" color={p.fgTertiary}>{index + 1} of {request.questions.length}</T> : null}
				<IconButton icon="close" label="Dismiss" size={16} onPress={() => void client.dismissQuestions(request.id)} style={{ width: 28, height: 28, marginRight: -6 }} />
			</View>
			<T variant="callout" weight="600" style={{ marginTop: 4 }}>{question.prompt}</T>
			<ScrollView style={{ maxHeight: 260, marginTop: 10 }} contentContainerStyle={{ gap: 6 }} keyboardShouldPersistTaps="handled">
				{question.options.map(option => {
					const on = chosen.includes(option.id);
					return (
						<Tap key={option.id} haptics="selection" onPress={() => setPicked(prev => {
							const cur = prev[question.id] ?? [];
							return { ...prev, [question.id]: question.multiple ? (cur.includes(option.id) ? cur.filter(id => id !== option.id) : [...cur, option.id]) : [option.id] };
						})} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', padding: 11, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: on ? p.violet : p.stroke, backgroundColor: on ? `${p.violet}1A` : p.fillFaint }}>
							<View style={{ width: 18, height: 18, marginTop: 1, borderRadius: question.multiple ? 5 : 9, borderWidth: 1.5, borderColor: on ? p.violet : p.fgQuaternary, backgroundColor: on ? p.violet : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
								{on ? <Icon name="check" size={11} color="#fff" strokeWidth={2.8} /> : null}
							</View>
							<View style={{ flex: 1 }}>
								<T variant="body" weight="500">{option.label}</T>
								{option.description ? <T variant="footnote" color={p.fgTertiary}>{option.description}</T> : null}
							</View>
						</Tap>
					);
				})}
				{question.allowOther ? (
					<TextInput
						value={other[question.id] ?? ''}
						onChangeText={value => setOther(o => ({ ...o, [question.id]: value }))}
						placeholder="Something else…"
						placeholderTextColor={p.fgQuaternary}
						selectionColor={p.violet}
						style={{ height: 44, borderRadius: 12, paddingHorizontal: 12, backgroundColor: p.fill, color: p.fg, fontSize: 15 }}
					/>
				) : null}
			</ScrollView>
			<View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
				{index > 0 ? <Button label="Back" variant="ghost" size="sm" onPress={() => setIndex(i => i - 1)} /> : null}
				<Button label="Skip" variant="ghost" size="sm" onPress={() => void client.answerQuestions(request.id, { outcome: 'skipped', answers: [] })} />
				<View style={{ flex: 1 }} />
				{last
					? <Button label="Submit" variant="primary" size="sm" busy={busy} disabled={!answered} onPress={() => void submit()} />
					: <Button label="Next" variant="primary" size="sm" disabled={!answered} onPress={() => setIndex(i => i + 1)} />}
			</View>
		</Animated.View>
	);
}

export function Banner({ icon, color, title, body, action, onAction }: { readonly icon: Parameters<typeof Icon>[0]['name']; readonly color: string; readonly title: string; readonly body?: string; readonly action: string; readonly onAction: () => void }) {
	const { p } = useTheme();
	return (
		<Animated.View entering={FadeInDown.duration(220)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16, backgroundColor: p.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke }}>
			<Icon name={icon} size={18} color={color} />
			<View style={{ flex: 1 }}>
				<T variant="small" weight="600">{title}</T>
				{body ? <T variant="footnote" color={p.fgTertiary} numberOfLines={2}>{body}</T> : null}
			</View>
			<Button label={action} size="sm" onPress={onAction} />
		</Animated.View>
	);
}

export function LimitBanner({ chatId, thread }: { readonly chatId: string; readonly thread: IOrchThread }) {
	const { p } = useTheme();
	const client = useClient();
	const limit = thread.limit!;
	return <Banner icon="clock" color={p.warning} title="Paused at a usage limit" body={`${limit.message ?? 'The provider stopped this turn.'}${limit.resetAt ? ` Resumes around ${clockTime(limit.resetAt)}.` : ''}`} action="Resume" onAction={() => void client.resumeLimit(chatId)} />;
}

export function PausedBanner({ chatId, thread }: { readonly chatId: string; readonly thread: IOrchThread }) {
	const { p } = useTheme();
	const client = useClient();
	const reason = thread.pause === 'failed' ? 'The last turn failed.' : thread.pause === 'stopped' ? 'You stopped the last turn.' : thread.pause === 'interrupted' ? 'Volt restarted during the last turn.' : 'Waiting for you.';
	return <Banner icon="pause" color={p.fgTertiary} title={`${thread.queue.length} queued ${thread.queue.length === 1 ? 'prompt' : 'prompts'} waiting`} body={reason} action="Resume" onAction={() => void client.resumeQueue(chatId)} />;
}

export function QueueChip({ chatId, thread }: { readonly chatId: string; readonly thread: IOrchThread }) {
	const { p } = useTheme();
	const client = useClient();
	const [open, setOpen] = useState(false);
	if (!thread.queue.length) {
		return null;
	}
	return (
		<View style={{ borderRadius: 16, backgroundColor: p.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, overflow: 'hidden' }}>
			<Tap haptics="selection" onPress={() => setOpen(o => !o)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 12 }}>
				<Icon name="queue" size={15} color={p.accent} />
				<T variant="small" weight="600" color={p.accent}>{thread.queue.length} queued</T>
				<T variant="small" color={p.fgTertiary} numberOfLines={1} style={{ flex: 1 }}>{firstLine(thread.queue[0].prompt.text, 80)}</T>
				<View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="chevronUp" size={14} color={p.fgQuaternary} /></View>
			</Tap>
			{open ? thread.queue.map((item, i) => (
				<View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 4, minHeight: 44, borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
					<View style={{ width: 20, height: 20, borderRadius: 6, backgroundColor: p.fill, alignItems: 'center', justifyContent: 'center' }}><T variant="caption" color={p.fgTertiary}>{i + 1}</T></View>
					<T variant="small" numberOfLines={2} style={{ flex: 1 }}>{firstLine(item.prompt.text, 200)}</T>
					<IconButton icon="arrowUp" label="Send now" size={17} onPress={() => void client.sendQueuedNow(chatId, item.id)} />
					<IconButton icon="close" label="Remove" size={17} onPress={() => void client.removeQueued(chatId, item.id)} />
				</View>
			)) : null}
		</View>
	);
}
