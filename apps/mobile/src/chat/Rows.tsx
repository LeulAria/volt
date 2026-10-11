/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, compactNumber, dirname, duration, type IStepItem, money, pendingLabel, RADIUS, type TranscriptRow } from '@volt/client-core';
import { memo, type ReactNode, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useClient } from '../state/client';
import { FONT, useTheme } from '../theme/theme';
import { Icon, LiveTimer, Shimmer, T, Tap } from '../ui/core';
import { CodeBlock, copyWithHaptic, DiffView, Inline, Markdown, TableView } from './Markdown';

type RowOf<K extends TranscriptRow['kind']> = Extract<TranscriptRow, { kind: K }>;

function Disclosure({ open, onToggle, children, onLongPress }: { readonly open: boolean; readonly onToggle: () => void; readonly children: ReactNode; readonly onLongPress?: () => void }) {
	const { p } = useTheme();
	return (
		<Tap haptics="selection" onPress={onToggle} onLongPress={onLongPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 30, paddingVertical: 3 }}>
			{children}
			<View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
				<Icon name="chevronRight" size={13} color={p.fgQuaternary} />
			</View>
		</Tap>
	);
}

function UserRow({ row, chatId }: { readonly row: RowOf<'user'>; readonly chatId: string }) {
	const { p, mode } = useTheme();
	const client = useClient();
	const [expanded, setExpanded] = useState(false);
	const long = row.text.length > 700 || row.text.split('\n').length > 14;
	const tint = row.mode ? mode(row.mode as Parameters<typeof mode>[0]) : undefined;
	return (
		<Animated.View entering={row.pending ? FadeInDown.duration(220) : undefined} style={{ alignItems: 'flex-end', gap: 5 }}>
			{row.from ? (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
					<Icon name="message" size={12} color={p.fgTertiary} />
					<T variant="footnote" color={p.fgTertiary}>From {row.from}</T>
				</View>
			) : null}
			<Tap onLongPress={() => copyWithHaptic(row.text)} onPress={long ? () => setExpanded(e => !e) : undefined} style={{
				maxWidth: '88%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18, borderBottomRightRadius: 6,
				backgroundColor: p.bubble, borderWidth: StyleSheet.hairlineWidth, borderColor: row.pending === 'failed' ? p.danger : p.bubbleBorder,
				opacity: row.pending && row.pending !== 'failed' ? 0.7 : 1,
			}}>
				{row.mode && tint ? (
					<View style={{ alignSelf: 'flex-start', paddingHorizontal: 7, height: 19, borderRadius: 6, backgroundColor: tint.bg, justifyContent: 'center', marginBottom: 5 }}>
						<T variant="caption" weight="700" color={tint.fg}>{row.mode}</T>
					</View>
				) : null}
				<Text selectable={!long} numberOfLines={long && !expanded ? 12 : undefined} style={{ color: p.fg, fontSize: 15.5, lineHeight: 22 }}>{row.text}</Text>
				{row.chips.length ? (
					<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
						{row.chips.map(chip => (
							<View key={chip} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 22, paddingHorizontal: 7, borderRadius: 6, backgroundColor: p.fill }}>
								<Icon name="file" size={11} color={p.fgTertiary} />
								<T variant="footnote" color={p.fgSecondary} numberOfLines={1}>{chip}</T>
							</View>
						))}
					</View>
				) : null}
				{long ? <T variant="footnote" weight="600" color={p.fgTertiary} style={{ marginTop: 6 }}>{expanded ? 'Show less' : 'Show more'}</T> : null}
			</Tap>
			{row.pending ? (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
					{row.pending === 'sending' ? <ActivityIndicator size="small" color={p.fgTertiary} style={{ transform: [{ scale: 0.7 }] }} /> : <Icon name={row.pending === 'failed' ? 'alertCircle' : 'clock'} size={13} color={row.pending === 'failed' ? p.danger : p.fgTertiary} />}
					<T variant="footnote" color={row.pending === 'failed' ? p.danger : p.fgTertiary}>{pendingLabel(row.pending)}</T>
					{row.pending === 'failed' && row.turnId ? (
						<>
							<Tap haptics="light" onPress={() => client.retrySend(chatId, row.turnId!)} hitSlop={8}><T variant="footnote" weight="600">Retry</T></Tap>
							<Tap haptics="light" onPress={() => client.dismissPending(chatId, row.turnId!)} hitSlop={8}><T variant="footnote" weight="600" color={p.fgTertiary}>Dismiss</T></Tap>
						</>
					) : null}
				</View>
			) : null}
		</Animated.View>
	);
}

function ThoughtRow({ row }: { readonly row: RowOf<'thought'> }) {
	const { p } = useTheme();
	const [open, setOpen] = useState(false);
	const label = row.streaming ? 'Thinking' : row.durationMs && row.durationMs > 1000 ? `Thought for ${duration(row.durationMs)}` : 'Thought';
	return (
		<View>
			<Disclosure open={open} onToggle={() => setOpen(o => !o)}>
				<Icon name="thought" size={15} color={p.fgTertiary} />
				<Shimmer active={row.streaming}><T variant="small" color={p.fgTertiary}>{label}</T></Shimmer>
			</Disclosure>
			{open ? (
				<Animated.View entering={FadeIn.duration(180)} style={{ marginLeft: 7, paddingLeft: 14, borderLeftWidth: 1, borderColor: p.stroke, marginBottom: 4 }}>
					<Markdown text={row.text} compact />
				</Animated.View>
			) : null}
		</View>
	);
}

function StepBody({ step }: { readonly step: IStepItem }) {
	const { p } = useTheme();
	const body = step.body;
	if (!body) {
		return null;
	}
	const box = { marginLeft: 24, marginTop: 4, marginBottom: 6, borderRadius: RADIUS.md, backgroundColor: p.codeBg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, overflow: 'hidden' as const };
	if (body.kind === 'command') {
		return (
			<Animated.View entering={FadeIn.duration(180)} style={box}>
				<Text selectable style={{ fontFamily: FONT.mono, fontSize: 12, lineHeight: 18, color: p.fg, padding: 10, borderBottomWidth: body.output ? StyleSheet.hairlineWidth : 0, borderColor: p.strokeFaint }}>
					<Text style={{ color: p.success }}>$ </Text>{body.command}
				</Text>
				{body.output ? <Text selectable numberOfLines={40} style={{ fontFamily: FONT.mono, fontSize: 11.5, lineHeight: 17, color: p.fgSecondary, padding: 10 }}>{body.output.slice(0, 8000)}</Text> : null}
				{body.exitCode !== undefined && body.exitCode !== 0 ? <T variant="footnote" mono color={p.danger} style={{ paddingHorizontal: 10, paddingBottom: 8 }}>exit {body.exitCode}</T> : null}
			</Animated.View>
		);
	}
	if (body.kind === 'diff') {
		return <View style={box}><DiffView diff={body.diff} /></View>;
	}
	return (
		<Animated.View entering={FadeIn.duration(180)} style={box}>
			<Text selectable numberOfLines={40} style={{ fontFamily: body.mono ? FONT.mono : undefined, fontSize: body.mono ? 11.5 : 13, lineHeight: body.mono ? 17 : 19, color: p.fgSecondary, padding: 10 }}>{body.text.slice(0, 6000)}</Text>
		</Animated.View>
	);
}

function StepLine({ step }: { readonly step: IStepItem }) {
	const { p } = useTheme();
	const [open, setOpen] = useState(false);
	const color = step.status === 'error' ? p.danger : p.fgSecondary;
	return (
		<View>
			<Tap disabled={!step.body} haptics="selection" onPress={() => setOpen(o => !o)} onLongPress={() => step.detail && copyWithHaptic(step.detail)} style={{ flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 30 }}>
				<View style={{ width: 15, alignItems: 'center' }}>
					{step.status === 'running' ? <ActivityIndicator size="small" color={p.info} style={{ transform: [{ scale: 0.65 }] }} /> : <Icon name={step.status === 'error' ? 'xCircle' : step.icon} size={14} color={step.status === 'error' ? p.danger : p.fgTertiary} />}
				</View>
				<Shimmer active={step.status === 'running'}><T variant="small" weight="500" color={color}>{step.label}</T></Shimmer>
				{step.detail ? <T variant="footnote" mono color={p.fgTertiary} numberOfLines={1} style={{ flex: 1 }}>{step.detail}</T> : <View style={{ flex: 1 }} />}
				{step.body ? <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevronRight" size={12} color={p.fgQuaternary} /></View> : null}
			</Tap>
			{open ? <StepBody step={step} /> : null}
		</View>
	);
}

function StepsRow({ row }: { readonly row: RowOf<'steps'> }) {
	const { p } = useTheme();
	const [open, setOpen] = useState<boolean | undefined>(undefined);
	const expanded = open ?? row.live;
	const tail = row.live && open === undefined;
	const shown = expanded ? (tail ? row.items.slice(-3) : row.items) : [];
	const current = row.items[row.items.length - 1];
	return (
		<View>
			<Disclosure open={expanded} onToggle={() => setOpen(!expanded)}>
				<Shimmer active={row.live}>
					<T variant="small" color={p.fgTertiary} numberOfLines={1}>{row.live ? `${current?.label ?? 'Working'}${current?.detail ? ` ${current.detail}` : ''}` : row.summary}</T>
				</Shimmer>
				{row.live && row.items.length > 1 ? <T variant="footnote" color={p.fgQuaternary}>+{row.items.length - 1}</T> : null}
			</Disclosure>
			{expanded ? (
				<Animated.View entering={FadeIn.duration(180)} style={{ paddingLeft: 2 }}>
					{tail && row.items.length > 3 ? <T variant="footnote" color={p.fgQuaternary} style={{ marginLeft: 24, marginBottom: 2 }}>{row.items.length - 3} earlier steps</T> : null}
					{shown.map(step => <StepLine key={step.key} step={step} />)}
				</Animated.View>
			) : null}
		</View>
	);
}

function FileRow({ row }: { readonly row: RowOf<'file'> }) {
	const { p } = useTheme();
	const [open, setOpen] = useState(false);
	const dir = dirname(row.path);
	return (
		<View style={{ borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, backgroundColor: p.fillFaint, overflow: 'hidden' }}>
			<Tap disabled={!row.diff} haptics="selection" onPress={() => setOpen(o => !o)} onLongPress={() => copyWithHaptic(row.path)} style={{ flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 12, paddingVertical: 10 }}>
				{row.status === 'running' ? <ActivityIndicator size="small" color={p.info} style={{ transform: [{ scale: 0.7 }] }} /> : <Icon name={row.verb === 'Created' ? 'plus' : row.verb === 'Deleted' ? 'trash' : 'pencil'} size={15} color={p.fgTertiary} />}
				<View style={{ flex: 1, minWidth: 0 }}>
					<T variant="small" mono weight="500" numberOfLines={1}>{basename(row.path)}</T>
					{dir ? <T variant="caption" mono color={p.fgQuaternary} numberOfLines={1} ellipsizeMode="head">{dir}</T> : null}
				</View>
				{row.additions ? <T variant="footnote" mono color={p.diffAddedFg}>+{row.additions}</T> : null}
				{row.deletions ? <T variant="footnote" mono color={p.diffRemovedFg}>{'−'}{row.deletions}</T> : null}
				{row.diff ? <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="chevronDown" size={13} color={p.fgQuaternary} /></View> : null}
			</Tap>
			{open && row.diff ? <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}><DiffView diff={row.diff} /></View> : null}
		</View>
	);
}

function CardHead({ icon, label, color, right }: { readonly icon: Parameters<typeof Icon>[0]['name']; readonly label: string; readonly color?: string; readonly right?: ReactNode }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8 }}>
			<Icon name={icon} size={15} color={color ?? p.fgSecondary} />
			<T variant="small" weight="600" color={color ?? p.fgSecondary} style={{ flex: 1 }}>{label}</T>
			{right}
		</View>
	);
}

function card(p: ReturnType<typeof useTheme>['p'], border?: string) {
	return { borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: border ?? p.stroke, backgroundColor: p.surface, padding: 14 };
}

function TodosRow({ row }: { readonly row: RowOf<'todos'> }) {
	const { p } = useTheme();
	const [open, setOpen] = useState(row.live);
	const done = row.steps.filter(s => s.state === 'done').length;
	return (
		<View>
			<Disclosure open={open} onToggle={() => setOpen(o => !o)}>
				<Icon name="listChecks" size={15} color={p.fgTertiary} />
				<T variant="small" color={p.fgTertiary}>To-dos</T>
				<View style={{ width: 54, height: 4, borderRadius: 2, backgroundColor: p.fillStrong, overflow: 'hidden' }}>
					<View style={{ width: `${(done / Math.max(1, row.steps.length)) * 100}%`, height: 4, backgroundColor: p.success }} />
				</View>
				<T variant="footnote" color={p.fgQuaternary}>{done}/{row.steps.length}</T>
			</Disclosure>
			{open ? (
				<View style={{ gap: 4, marginTop: 2, marginBottom: 4 }}>
					{row.steps.map((step, i) => (
						<View key={`${i}:${step.label}`} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
							<View style={{ width: 16, height: 16, marginTop: 2, borderRadius: 8, borderWidth: 1.5, borderColor: step.state === 'done' ? p.success : step.state === 'current' ? p.info : p.fgQuaternary, backgroundColor: step.state === 'done' ? p.success : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
								{step.state === 'done' ? <Icon name="check" size={10} color={p.onPrimary} strokeWidth={2.8} /> : step.state === 'current' ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.info }} /> : null}
							</View>
							<T variant="small" color={step.state === 'done' ? p.fgQuaternary : step.state === 'current' ? p.fg : p.fgSecondary} weight={step.state === 'current' ? '500' : '400'} style={{ flex: 1, textDecorationLine: step.state === 'done' ? 'line-through' : 'none' }}>{step.label}</T>
						</View>
					))}
				</View>
			) : null}
		</View>
	);
}

function FooterRow({ row }: { readonly row: RowOf<'footer'> }) {
	const { p } = useTheme();
	const [copied, setCopied] = useState(false);
	const parts = [row.outcome === 'stopped' ? 'Stopped' : row.outcome === 'failed' ? 'Failed' : undefined, duration(row.durationMs), row.model, row.tokens ? `${compactNumber(row.tokens)} tokens` : undefined, money(row.costUsd)].filter(Boolean);
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
			{row.copyText ? (
				<Tap haptics="light" hitSlop={6} onPress={() => {
					copyWithHaptic(row.copyText);
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				}} style={{ width: 30, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8 }} accessibilityLabel="Copy reply">
					<Icon name={copied ? 'check' : 'copy'} size={14} color={copied ? p.success : p.fgTertiary} />
				</Tap>
			) : null}
			<T variant="footnote" color={p.fgQuaternary} numberOfLines={1} style={{ flex: 1 }}>{parts.join(' · ')}</T>
		</View>
	);
}

function SystemRow({ row }: { readonly row: RowOf<'system'> }) {
	const { p } = useTheme();
	const [open, setOpen] = useState(false);
	return (
		<View>
			<Disclosure open={open} onToggle={() => setOpen(o => !o)}>
				<Icon name={row.icon} size={15} color={p.fgTertiary} />
				<T variant="small" color={p.fgTertiary}>{row.title}</T>
			</Disclosure>
			{open ? <View style={{ ...card(p, p.strokeFaint), backgroundColor: p.fillFaint, marginTop: 4 }}><Markdown text={row.body} compact /></View> : null}
		</View>
	);
}

export const RowView = memo(function RowView({ row, chatId }: { readonly row: TranscriptRow; readonly chatId: string }): ReactNode {
	const { p } = useTheme();
	switch (row.kind) {
		case 'user':
			return <UserRow row={row} chatId={chatId} />;
		case 'markdown':
			return <Markdown text={row.text} docKey={row.docKey} streaming={row.streaming} />;
		case 'thought':
			return <ThoughtRow row={row} />;
		case 'steps':
			return <StepsRow row={row} />;
		case 'file':
			return <FileRow row={row} />;
		case 'code':
			return <CodeBlock code={row.code} lang={row.lang} path={row.path} streaming={row.streaming} />;
		case 'table':
			return <TableView header={row.headers} rows={row.rows} />;
		case 'plan':
			return (
				<View style={card(p, `${p.warning}55`)}>
					<CardHead icon="book" label={row.title} color={p.warning} right={row.streaming ? <ActivityIndicator size="small" color={p.warning} /> : undefined} />
					<Markdown text={row.markdown} docKey={row.docKey} streaming={row.streaming} />
					{row.openQuestions?.length ? (
						<View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, gap: 4 }}>
							<T variant="small" weight="600" color={p.fgSecondary}>Open questions</T>
							{row.openQuestions.map(q => <Inline key={q} text={`• ${q}`} size={14} style={{ color: p.fgSecondary, lineHeight: 20 }} />)}
						</View>
					) : null}
				</View>
			);
		case 'decision':
			return (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
					<Icon name={row.decision === 'deny' || row.blocked ? 'xCircle' : row.decision === 'allow' ? 'shieldCheck' : 'shieldAlert'} size={15} color={row.decision === 'allow' ? p.success : row.decision === 'deny' || row.blocked ? p.danger : p.warning} />
					<T variant="small" color={p.fgTertiary}>{row.blocked ? 'Blocked' : row.decision === 'allow' ? row.scope === 'always' ? 'Always allowed' : 'Allowed' : row.decision === 'deny' ? 'Denied' : 'Asked'} {row.action}</T>
					<T variant="footnote" mono color={p.fgSecondary} numberOfLines={1} style={{ flex: 1 }}>{row.resource}</T>
				</View>
			);
		case 'answers':
			return (
				<View style={card(p)}>
					<CardHead icon="help" label={row.outcome === 'answered' ? 'Answers' : row.outcome === 'skipped' ? 'Skipped' : 'Dismissed'} />
					{row.items.map((item, i) => (
						<View key={i} style={{ paddingVertical: 6, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderColor: p.strokeFaint }}>
							<T variant="footnote" color={p.fgTertiary}>{item.question}</T>
							<T variant="body">{item.answer}</T>
						</View>
					))}
					{row.note ? <T variant="small" color={p.fgSecondary} style={{ marginTop: 6 }}>{row.note}</T> : null}
				</View>
			);
		case 'notice':
			return (
				<View style={{ flexDirection: 'row', gap: 9, alignItems: 'flex-start' }}>
					<Icon name={row.severity === 'error' ? 'alertCircle' : row.severity === 'warning' ? 'alert' : 'info'} size={15} color={row.severity === 'error' ? p.danger : row.severity === 'warning' ? p.warning : p.info} />
					<View style={{ flex: 1 }}>
						<T variant="small">{row.title}</T>
						{row.description ? <T variant="footnote" color={p.fgTertiary}>{row.description}</T> : null}
					</View>
				</View>
			);
		case 'error':
			return (
				<View style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: `${p.danger}66`, backgroundColor: `${p.danger}14` }}>
					<Icon name="alertCircle" size={17} color={p.danger} />
					<Text selectable style={{ flex: 1, color: p.fg, fontSize: 14, lineHeight: 20 }}>{row.message}</Text>
				</View>
			);
		case 'todos':
			return <TodosRow row={row} />;
		case 'chart': {
			const max = Math.max(1, ...row.values.map(v => Math.abs(v)));
			return (
				<View style={[card(p), { gap: 8 }]}>
					{row.title ? <CardHead icon="layers" label={row.title} /> : null}
					{row.labels.map((label, i) => (
						<View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
							<T variant="footnote" color={p.fgSecondary} numberOfLines={1} style={{ width: 96 }}>{label}</T>
							<View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: p.fill, overflow: 'hidden' }}>
								<View style={{ width: `${(Math.abs(row.values[i] ?? 0) / max) * 100}%`, height: 8, borderRadius: 4, backgroundColor: p.accent }} />
							</View>
							<T variant="footnote" color={p.fgTertiary}>{compactNumber(row.values[i])}{row.unit ?? ''}</T>
						</View>
					))}
				</View>
			);
		}
		case 'cards':
			return (
				<View style={{ gap: 8 }}>
					{row.items.map((item, i) => (
						<View key={i} style={card(p)}>
							<T variant="small" weight="600">{item.title}</T>
							<Inline text={item.body} size={13} style={{ color: p.fgSecondary, marginTop: 3, lineHeight: 19 }} />
							{item.meta ? <T variant="caption" color={p.fgQuaternary} style={{ marginTop: 6 }}>{item.meta}</T> : null}
						</View>
					))}
				</View>
			);
		case 'visual':
			return (
				<View style={[card(p), { flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
					<Icon name={row.visual === 'chart' ? 'layers' : 'globe'} size={18} color={p.fgTertiary} />
					<View style={{ flex: 1 }}>
						<T variant="small" weight="500">{row.title}</T>
						<T variant="footnote" color={p.fgTertiary}>{row.visual === 'chart' ? 'Chart' : 'Page'} shown in Volt on your computer</T>
					</View>
				</View>
			);
		case 'working':
			return (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 26 }}>
					<WorkingOrb />
					<Shimmer><T variant="small" color={p.fgTertiary}>{row.status}</T></Shimmer>
					<View style={{ flex: 1 }} />
					{row.since ? <LiveTimer since={row.since} color={p.fgQuaternary} /> : null}
				</View>
			);
		case 'footer':
			return <FooterRow row={row} />;
		case 'divider':
			return (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
					<View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: p.stroke }} />
					{row.live ? <ActivityIndicator size="small" color={p.fgTertiary} style={{ transform: [{ scale: 0.6 }] }} /> : <Icon name={row.icon} size={12} color={p.fgQuaternary} />}
					<T variant="footnote" color={p.fgTertiary} numberOfLines={1} style={{ maxWidth: '70%' }}>{row.label}{row.detail ? ` · ${row.detail}` : ''}</T>
					<View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: p.stroke }} />
				</View>
			);
		case 'system':
			return <SystemRow row={row} />;
	}
});

function WorkingOrb() {
	const { p } = useTheme();
	return (
		<Shimmer>
			<View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: p.info, shadowColor: p.info, shadowOpacity: 0.8, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }} />
		</Shimmer>
	);
}

/** Space above a row, from what precedes it (prompts open a turn; work log lines sit close). */
export function rowGap(row: TranscriptRow, prev: TranscriptRow | undefined): number {
	if (!prev) {
		return 0;
	}
	if (row.kind === 'user' || row.kind === 'system') {
		return prev.kind === 'divider' ? 10 : 26;
	}
	if (row.kind === 'footer') {
		return 2;
	}
	const quiet = (k: TranscriptRow['kind']) => k === 'steps' || k === 'thought' || k === 'todos';
	if (quiet(row.kind) && quiet(prev.kind)) {
		return 0;
	}
	if (row.kind === 'working') {
		return 10;
	}
	return 10;
}
