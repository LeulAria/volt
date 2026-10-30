/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	basename, compactNumber, dirname, duration, formatWorkedTime, type IRowImage, type IStepItem, type ISubagentItem, liveVerb, money, pendingLabel, receiptHeadline,
	receiptStatus, relativeTime, shellTokenColor, tokenizeShell, type TranscriptRow, TYPE
} from '@volt/client-core';
import { router } from 'expo-router';
import { memo, type ReactNode, useMemo, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { FileIcon } from '../files/FileIcon';
import { useAttachment, useClient } from '../state/client';
import { useConversationPrefs } from '../state/prefs';
import { FONT, useTheme } from '../theme/theme';
import { haptic, Icon, LiveTimer, ShimmerText, Spinner, Tap } from '../ui/core';
import { showImage } from '../ui/ImageViewer';
import { openFile, useChatContext } from './context';
import { CodeBlock, copyWithHaptic, Inline, Markdown, TableView } from './Markdown';
import { VisualCard } from './Visuals';
import { openSubagent, useChatTasks } from './Subagents';
import { TrDiff } from './TrDiff';

/**
 * The transcript's rows, drawn as the desktop draws them (agentTranscript.css,
 * agentTranscriptView.ts): 22px work log rows at 13px, the verb in the tertiary tone and the rest
 * in the quaternary, a chevron that turns open; edits as cards over a fading peek of their diff;
 * commands as `$ cmd` cards; replies at 14/22 in the light face.
 */

type RowOf<K extends TranscriptRow['kind']> = Extract<TranscriptRow, { kind: K }>;

const STEP = TYPE.step;

//#region Shared pieces

/** The chevron after a header: points right closed, down open (rotate(-90deg) → none). */
function Chevron({ open, visible = true }: { readonly open: boolean; readonly visible?: boolean }) {
	const { p } = useTheme();
	return (
		<View style={{ width: 12, height: 12, marginLeft: 3, opacity: visible ? 1 : 0, transform: [{ rotate: open ? '0deg' : '-90deg' }] }}>
			<Icon name="chevronDown" size={12} color={p.iconTertiary} strokeWidth={2} />
		</View>
	);
}

function Stats({ additions, deletions }: { readonly additions?: number; readonly deletions?: number }) {
	const { p } = useTheme();
	if (!additions && !deletions) {
		return null;
	}
	return (
		<View style={{ flexDirection: 'row', gap: 4, marginLeft: 4 }}>
			{additions ? <Text style={[styles.step, { color: p.diffAddedFg }]}>+{additions}</Text> : null}
			{deletions ? <Text style={[styles.step, { color: p.diffRemovedFg }]}>-{deletions}</Text> : null}
		</View>
	);
}

/**
 * A work log header (`.volt-tr-header`): the verb, the details, the stats, the chevron. Open or
 * pressed, the verb steps up to the secondary tone and the details to the tertiary.
 */
function Header({ action, detail, command, live, open, expandable, additions, deletions, exit, detailTone, onPress, onLongPress }: {
	readonly action: string;
	readonly detail?: string;
	readonly command?: string;
	readonly live?: boolean;
	readonly open: boolean;
	readonly expandable: boolean;
	readonly additions?: number;
	readonly deletions?: number;
	readonly exit?: number;
	readonly detailTone?: 'tertiary';
	readonly onPress?: () => void;
	readonly onLongPress?: () => void;
}) {
	const { p } = useTheme();
	const [pressed, setPressed] = useState(false);
	const lit = open || pressed;
	return (
		<Tap
			disabled={!onPress && !onLongPress}
			haptics={onPress ? 'selection' : undefined}
			onPress={onPress}
			onLongPress={onLongPress}
			delayLongPress={350}
			onPressIn={() => setPressed(true)}
			onPressOut={() => setPressed(false)}
			hitSlop={{ top: 4, bottom: 4 }}
			style={styles.header}
		>
			<ShimmerText active={!!live} color={lit ? p.fgSecondary : p.fgTertiary} style={[styles.step, styles.action]} numberOfLines={1}>{action}</ShimmerText>
			{detail ? <Text numberOfLines={1} style={[styles.step, styles.detail, { color: lit || detailTone ? p.fgTertiary : p.fgQuaternary }]}>{detail}{command ? <Text style={{ color: p.fgQuaternary }}>{` ${command}`}</Text> : null}</Text> : null}
			<Stats additions={additions} deletions={deletions} />
			{exit !== undefined ? <Text style={[styles.exit, { color: p.diffRemovedFg }]}>exit {exit}</Text> : null}
			{expandable ? <Chevron open={open} /> : null}
		</Tap>
	);
}

/** Cursor's command card: `$ cmd args` then the output, 13/18 mono, 200px before it scrolls. */
export const TerminalCard = memo(function TerminalCard({ command, output }: { readonly command: string; readonly output: string }) {
	const { p } = useTheme();
	const tokens = useMemo(() => tokenizeShell(command), [command]);
	const text = output.replace(/[\r\n]+$/, '');
	return (
		<View style={[styles.terminal, { backgroundColor: p.card, borderColor: p.strokeFaint }]}>
			<ScrollView nestedScrollEnabled style={{ maxHeight: 200 }} showsVerticalScrollIndicator={false}>
				<Text selectable style={[styles.termText, styles.termCommand, { fontFamily: FONT.mono, color: p.fgQuaternary }]}>
					{'$ '}
					{tokens.map((token, i) => {
						const color = token.kind === 'op' ? p.fgTertiary : shellTokenColor(token.kind, p.scheme);
						return color ? <Text key={i} style={{ color }}>{token.value}</Text> : token.value;
					})}
				</Text>
				{text ? <Text selectable style={[styles.termText, styles.termOutput, { fontFamily: FONT.mono, color: p.fgQuaternary }]}>{text.length > 12000 ? `…${text.slice(-12000)}` : text}</Text> : null}
			</ScrollView>
			<Tap haptics="light" hitSlop={8} onPress={() => copyWithHaptic(command)} accessibilityLabel="Copy command" style={styles.termMenu}>
				<Icon name="copy" size={12} color={p.fgTertiary} />
			</Tap>
		</View>
	);
});

/** A tool's input or output in the command card's frame. */
function ToolOutput({ text }: { readonly text: string }) {
	const { p } = useTheme();
	return (
		<View style={[styles.terminal, { backgroundColor: p.card, borderColor: p.strokeFaint }]}>
			<ScrollView nestedScrollEnabled style={{ maxHeight: 200 }} showsVerticalScrollIndicator={false}>
				<Text selectable style={[styles.termText, { fontFamily: FONT.mono, color: p.fgQuaternary, paddingHorizontal: 10, paddingVertical: 6 }]}>{text.length > 12000 ? `${text.slice(0, 12000)}…` : text.replace(/[\r\n]+$/, '')}</Text>
			</ScrollView>
		</View>
	);
}

/** Reasoning behind "Thought 6s": the step rows' size at half strength. */
function Reasoning({ text }: { readonly text: string }) {
	return (
		<View style={{ opacity: 0.5 }}>
			<Markdown text={text} tone="thinking" />
		</View>
	);
}

//#endregion

//#region Prompts

/** A sent image: a rounded thumbnail that opens full screen. */
const MessageImage = memo(function MessageImage({ image, size }: { readonly image: IRowImage; readonly size: number }) {
	const { p } = useTheme();
	const uri = useAttachment(image.ref);
	return (
		<Tap haptics="light" disabled={!uri} onPress={() => uri && showImage(uri, image.name)} accessibilityLabel={`Image ${image.name}`} style={{ width: size, height: size, borderRadius: 8, overflow: 'hidden', backgroundColor: p.fill, borderWidth: 1, borderColor: p.bubbleBorder, alignItems: 'center', justifyContent: 'center' }}>
			{uri ? <Image source={{ uri }} style={{ width: size, height: size }} resizeMode="cover" /> : <ActivityIndicator size="small" color={p.fgTertiary} />}
		</Tap>
	);
});

function MessageImages({ images }: { readonly images: readonly IRowImage[] }) {
	const size = images.length === 1 ? 200 : images.length === 2 ? 132 : 92;
	return (
		<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
			{images.map(image => <MessageImage key={image.ref} image={image} size={size} />)}
		</View>
	);
}

/** Lines a long prompt shows before "Read more" (the desktop clamps to two). */
const CLAMP_LINES = 2;

/** About how many lines `text` wraps to in `width` points at 14px light (6.4pt a character on average). */
function estimateLines(text: string, width: number): number {
	const perLine = Math.max(12, Math.floor(width / 6.4));
	let lines = 0;
	for (const paragraph of text.split('\n')) {
		lines += Math.max(1, Math.ceil(paragraph.length / perLine));
		if (lines > CLAMP_LINES + 1) {
			break;
		}
	}
	return lines;
}

/**
 * The desktop's sent prompt (agentEditor.css `.volt-agent-turn.user .volt-agent-bubble`): the
 * composer's own fill and edge, 8px corners, 8/12 padding, 14/22 light text. A long one shows
 * two lines and Read more; the running one holds Stop in its corner.
 */
function UserRow({ row, chatId }: { readonly row: RowOf<'user'>; readonly chatId: string }) {
	const { p, mode } = useTheme();
	const client = useClient();
	const ctx = useChatContext();
	const [expanded, setExpanded] = useState(false);
	const { width } = useWindowDimensions();
	// Estimated from the column's width, so a long prompt draws clamped from the first frame (no jump in the list).
	const long = useMemo(() => estimateLines(row.text, width - 2 * 14 - 26) > CLAMP_LINES, [row.text, width]);
	const clamped = long && !expanded;
	const tint = row.mode ? mode(row.mode as Parameters<typeof mode>[0]) : undefined;
	// Sent prompts typed here or on the desktop take the menu; another chat's message, a steer or a pending one don't.
	const actionable = !!ctx && !ctx.readOnly && !!row.turnId && !row.pending && !row.from && !row.steer;
	const menu = () => {
		if (actionable) {
			haptic.medium();
			ctx.onMessageMenu(row);
		} else {
			copyWithHaptic(row.text);
		}
	};
	const imageOnly = !!row.images?.length && /^See the (\d+ )?attached images?\.$/.test(row.text);
	const stop = row.running && ctx?.onStop && !ctx.readOnly;
	return (
		<Animated.View entering={row.pending ? FadeInDown.duration(220) : undefined} style={{ gap: 6 }}>
			{row.from ? (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
					<Icon name="message" size={12} color={p.iconTertiary} />
					<Text style={[styles.step, { color: p.fgTertiary }]}>From {row.from}</Text>
				</View>
			) : null}
			{row.images?.length ? <MessageImages images={row.images} /> : null}
			{imageOnly ? null : (
				<Tap
					onLongPress={menu}
					delayLongPress={320}
					onPress={long ? () => setExpanded(e => !e) : actionable ? menu : undefined}
					style={[styles.prompt, {
						backgroundColor: p.bubble,
						borderColor: row.pending === 'failed' ? p.danger : p.bubbleBorder,
						opacity: row.pending && row.pending !== 'failed' ? 0.7 : 1,
					}]}
				>
					<View style={styles.promptMain}>
						{row.mode && tint ? (
							<View style={[styles.userMode, { backgroundColor: tint.bg }]}>
								<Text style={{ fontSize: 11, lineHeight: 18, fontWeight: '600', color: tint.fg }}>{row.mode}</Text>
							</View>
						) : null}
						<View>
							<Text selectable={!clamped} numberOfLines={clamped ? CLAMP_LINES : undefined} style={[styles.userText, { color: p.fg }]}>
								{row.text}
							</Text>
							{clamped ? (
								// Read more holds the last line's corner; the line fades out under it.
								<View pointerEvents="none" style={[styles.readMore, { right: stop ? 24 : 0 }]}>
									<Svg width={32} height={22}>
										<Defs>
											<LinearGradient id="readMore" x1="0" y1="0" x2="1" y2="0">
												<Stop offset="0" stopColor={p.bubble} stopOpacity={0} />
												<Stop offset="1" stopColor={p.bubble} stopOpacity={1} />
											</LinearGradient>
										</Defs>
										<Rect x="0" y="0" width="32" height="22" fill="url(#readMore)" />
									</Svg>
									<View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 22, backgroundColor: p.bubble }}>
										<Text style={{ fontSize: 12, lineHeight: 22, fontWeight: '500', color: p.fg, opacity: 0.7 }}>Read more</Text>
										<View style={{ opacity: 0.7 }}><Icon name="chevronDown" size={13} color={p.fg} /></View>
									</View>
								</View>
							) : null}
						</View>
						{row.chips.length ? (
							<View style={styles.chips}>
								{row.chips.map(chip => (
									<View key={chip} style={[styles.chip, { backgroundColor: p.fill }]}>
										<FileIcon path={chip} size={14} />
										<Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: p.fgSecondary, flexShrink: 1 }}>{chip}</Text>
									</View>
								))}
							</View>
						) : null}
					</View>
					{stop ? (
						<Tap haptics="medium" hitSlop={8} onPress={ctx.onStop} accessibilityLabel="Stop" style={[styles.userStop, { backgroundColor: p.fg }]}>
							<View style={{ width: 8, height: 8, borderRadius: 1.5, backgroundColor: p.canvas }} />
						</Tap>
					) : null}
				</Tap>
			)}
			{ctx && row.turnId && ctx.redoTurnId === row.turnId ? (
				<Tap haptics="light" onPress={ctx.onRedo} style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, height: 26, paddingHorizontal: 10, borderRadius: 999, backgroundColor: p.fill }}>
					<Icon name="undo" size={12} color={p.fgSecondary} />
					<Text style={{ fontSize: 12, fontWeight: '500', color: p.fgSecondary }}>Redo checkpoint</Text>
				</Tap>
			) : null}
			{row.pending ? (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13 }}>
					{row.pending === 'sending' ? <Spinner size={12} /> : <Icon name={row.pending === 'failed' ? 'alertCircle' : 'clock'} size={12} color={row.pending === 'failed' ? p.danger : p.iconTertiary} />}
					<Text style={[styles.step, { color: row.pending === 'failed' ? p.danger : p.fgTertiary }]}>{pendingLabel(row.pending)}</Text>
					{row.pending === 'failed' && row.turnId ? (
						<>
							<Tap haptics="light" onPress={() => client.retrySend(chatId, row.turnId!)} hitSlop={8}><Text style={[styles.step, { color: p.fg, fontWeight: '500' }]}>Retry</Text></Tap>
							<Tap haptics="light" onPress={() => client.dismissPending(chatId, row.turnId!)} hitSlop={8}><Text style={[styles.step, { color: p.fgTertiary }]}>Dismiss</Text></Tap>
						</>
					) : null}
				</View>
			) : null}
		</Animated.View>
	);
}

/**
 * The prompt of the turn being read, held at the top while its reply scrolls by (the desktop's
 * sticky prompt, painted solid). Tapping it goes back to it.
 */
export function PinnedPrompt({ row, onPress }: { readonly row: RowOf<'user'>; readonly onPress: () => void }) {
	const { p, dark } = useTheme();
	return (
		<Tap haptics="selection" onPress={onPress} accessibilityLabel="Go to this prompt" style={[styles.prompt, { backgroundColor: dark ? p.raised : p.bubble, borderColor: p.bubbleBorder, alignItems: 'center' }]}>
			<Text numberOfLines={1} style={[styles.userText, { flex: 1, color: p.fg }]}>{row.text}</Text>
			<Icon name="arrowUp" size={13} color={p.iconTertiary} />
		</Tap>
	);
}

//#endregion

//#region Work

function ThoughtLine({ text, detail, live }: { readonly text: string; readonly detail?: string; readonly live: boolean }) {
	const [open, setOpen] = useState(false);
	if (live) {
		return <Header action="Thinking" live open={false} expandable={false} />;
	}
	const has = !!text.trim();
	return (
		<View>
			<Header action="Thought" detail={detail} open={open} expandable={has} onPress={has ? () => setOpen(o => !o) : undefined} />
			{open ? <Animated.View entering={FadeIn.duration(160)} style={{ paddingTop: 4 }}><Reasoning text={text} /></Animated.View> : null}
		</View>
	);
}

/** One step: its line, and its command, diff or output when opened. `card` starts it open in a frame (detailed). */
const StepLine = memo(function StepLine({ step, live, card }: { readonly step: IStepItem; readonly live: boolean; readonly card?: boolean }) {
	const { p } = useTheme();
	const body = step.body;
	const [open, setOpen] = useState(!!card && !!body);
	if (step.kind === 'thought') {
		return <ThoughtLine text={body?.kind === 'thought' ? body.text : ''} detail={step.detail} live={live && step.status === 'running'} />;
	}
	const running = live && step.status === 'running';
	const header = (
		<Header
			action={running ? liveVerb(step) : step.label}
			detail={step.detail}
			command={step.command}
			live={running}
			open={open}
			expandable={!!body}
			additions={step.additions}
			deletions={step.deletions}
			exit={step.exitCode}
			onPress={body ? () => setOpen(o => !o) : undefined}
			onLongPress={step.detail ? () => copyWithHaptic(body?.kind === 'command' ? body.command : step.detail!) : undefined}
		/>
	);
	const content = open && body ? (
		<Animated.View entering={FadeIn.duration(160)} style={card ? { borderTopWidth: 1, borderColor: p.strokeFaint } : { paddingTop: 4 }}>
			{body.kind === 'command' ? <TerminalCard command={body.command} output={body.output} />
				: body.kind === 'diff' ? <TrDiff diff={body.diff} framed={!card} />
					: body.kind === 'thought' ? <Reasoning text={body.text} />
						: <ToolOutput text={body.text} />}
		</Animated.View>
	) : null;
	if (card && body) {
		return (
			<View style={[styles.card, { backgroundColor: p.card, borderColor: p.stroke }]}>
				<View style={{ paddingHorizontal: 10, paddingVertical: 4 }}>{header}</View>
				{content}
			</View>
		);
	}
	return <View>{header}{content}</View>;
});

/** A stretch of tool work: one group line that opens to a line per step (or the lines themselves, by density). */
function StepsRow({ row }: { readonly row: RowOf<'steps'> }) {
	const [open, setOpen] = useState(false);
	if (row.display === 'lines' || row.display === 'cards') {
		return (
			<View style={{ gap: row.display === 'cards' ? 6 : 0 }}>
				{row.items.map((step, i) => <StepLine key={step.key} step={step} live={row.live && i === row.items.length - 1} card={row.display === 'cards'} />)}
			</View>
		);
	}
	return (
		<View>
			<Header
				action={row.action}
				detail={row.detail}
				live={row.live}
				open={open}
				expandable
				additions={row.additions}
				deletions={row.deletions}
				onPress={() => setOpen(o => !o)}
			/>
			{open ? (
				<Animated.View entering={FadeIn.duration(160)} style={{ paddingTop: 4, gap: 4 }}>
					{row.items.map((step, i) => <StepLine key={step.key} step={step} live={row.live && i === row.items.length - 1} />)}
				</Animated.View>
			) : null}
		</View>
	);
}

/**
 * One edit between the other steps (`.volt-tr-edit-card`): file icon, name and +a -b over the
 * first four lines of its diff, fading out. The header or the peek opens the whole diff.
 */
function EditCard({ row }: { readonly row: RowOf<'file'> }) {
	const { p } = useTheme();
	const { toolDensity } = useConversationPrefs();
	const [open, setOpen] = useState(toolDensity === 'detailed');
	const running = row.status === 'running';
	const toggle = () => setOpen(o => !o);
	return (
		<View style={[styles.card, { backgroundColor: p.card, borderColor: p.stroke, marginVertical: 2 }]}>
			<Tap haptics="selection" onPress={toggle} onLongPress={() => row.verb !== 'Deleted' ? openFile(row.path) : copyWithHaptic(row.path)} delayLongPress={350} style={styles.editHeader}>
				<FileIcon path={row.path} size={16} />
				<ShimmerText active={running} color={p.fgSecondary} numberOfLines={1} style={[styles.step, { flexShrink: 1, lineHeight: 30 }]}>
					{basename(row.path)}
				</ShimmerText>
				{row.verb !== 'Edited' ? <Text style={[styles.step, { color: p.fgQuaternary, lineHeight: 30 }]}>{row.verb === 'Created' ? 'new' : 'deleted'}</Text> : null}
				<Stats additions={row.additions} deletions={row.deletions} />
				<View style={{ flex: 1 }} />
				<Chevron open={open} />
			</Tap>
			{row.diff || running ? (
				<Tap disabled={open} onPress={toggle} style={{ borderTopWidth: 1, borderColor: p.strokeFaint }}>
					<TrDiff diff={row.diff ?? ''} peek={!open} streaming={running} />
				</Tap>
			) : null}
		</View>
	);
}

/** Subagents: a spinner (or check) and the task, its kind, the step it is on; three or more fold under one line. */
function SubagentsRow({ row }: { readonly row: RowOf<'subagents'> }) {
	const { p } = useTheme();
	const [open, setOpen] = useState(false);
	if (row.items.length < 3) {
		return <View style={{ gap: 4 }}>{row.items.map(item => <SubagentLine key={item.key} item={item} />)}</View>;
	}
	const working = row.items.filter(item => item.state === 'running').length;
	return (
		<View>
			<Header action={`${row.items.length} subagents`} detail={working ? `${working} working` : undefined} live={row.live} open={open} expandable onPress={() => setOpen(o => !o)} />
			{open ? <Animated.View entering={FadeIn.duration(160)} style={{ paddingTop: 4, gap: 4 }}>{row.items.map(item => <SubagentLine key={item.key} item={item} />)}</Animated.View> : null}
			{!open && working ? <Text numberOfLines={1} style={[styles.step, { color: p.fgQuaternary, paddingLeft: 0 }]}>{row.items.find(item => item.state === 'running')?.status}</Text> : null}
		</View>
	);
}

const SubagentLine = memo(function SubagentLine({ item }: { readonly item: ISubagentItem }) {
	const { p } = useTheme();
	const ctx = useChatContext();
	const tasks = useChatTasks(ctx?.chatId ?? '');
	const task = tasks.find(t => t.title === item.title || t.brief?.startsWith(item.title));
	const [open, setOpen] = useState(false);
	const live = item.state === 'running';
	const expandable = !task && !!item.output;
	return (
		<Tap disabled={!task && !expandable} haptics="selection" onPress={() => task ? openSubagent(task) : setOpen(o => !o)} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
			<View style={{ width: 20, height: 22, alignItems: 'center', justifyContent: 'center' }}>
				{live ? <Spinner size={13} /> : <Icon name={item.state === 'stopped' ? 'stop' : item.state === 'failed' ? 'xCircle' : 'check'} size={13} color={item.state === 'failed' ? p.danger : p.iconTertiary} strokeWidth={2} />}
			</View>
			<View style={{ flex: 1, minWidth: 0 }}>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
					<Text numberOfLines={1} style={[styles.step, { color: p.fg, flexShrink: 1 }]}>{item.title}</Text>
					{item.type ? <Text style={[styles.step, { color: p.fgQuaternary }]}>{item.type}</Text> : null}
					{task ? <Icon name="chevronRight" size={12} color={p.iconTertiary} /> : expandable ? <Chevron open={open} /> : null}
				</View>
				<View style={{ flexDirection: 'row', gap: 6 }}>
					<ShimmerText active={live} color={p.fgQuaternary} numberOfLines={1} style={[styles.step, { flexShrink: 1 }]}>{task?.activity && live ? task.activity : item.status}</ShimmerText>
					{live && item.steps > 1 ? <Text style={[styles.step, { color: p.fgQuaternary }]}>{item.steps} steps</Text> : null}
				</View>
				{open && item.output ? <View style={{ paddingTop: 4 }}><ToolOutput text={item.output} /></View> : null}
			</View>
		</Tap>
	);
});

/** "Compacting context" while the agent summarizes the chat, then "Context compacted" between two hairlines. */
function CompactionRow({ row }: { readonly row: RowOf<'compaction'> }) {
	const { p } = useTheme();
	const [open, setOpen] = useState(false);
	const running = row.status === 'running';
	const failed = row.status === 'failed';
	const label = running ? 'Compacting context' : failed ? 'Compaction failed' : row.status === 'cancelled' ? 'Compaction stopped' : 'Context compacted';
	return (
		<View>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 24 }}>
				<View style={{ flex: 1, height: 1, backgroundColor: p.stroke }} />
				<Tap disabled={!row.summary} haptics="selection" onPress={() => setOpen(o => !o)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
					<Icon name="minimize" size={13} color={failed ? p.warning : p.iconTertiary} />
					<ShimmerText active={running} color={open ? p.fgSecondary : p.fgTertiary} style={{ fontSize: 13, lineHeight: 20 }}>{label}</ShimmerText>
					{row.detail ? <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 20, color: p.fgQuaternary, flexShrink: 1 }}>{row.detail}</Text> : null}
					{row.summary ? <Chevron open={open} /> : null}
				</Tap>
				<View style={{ flex: 1, height: 1, backgroundColor: p.stroke }} />
			</View>
			{open && row.summary ? (
				<View style={{ marginTop: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: p.fillFaint }}>
					<Reasoning text={row.summary} />
				</View>
			) : null}
		</View>
	);
}

/** "Worked for 3m 3s": the fold over everything before a finished turn's answer. */
function WorkedRow({ row }: { readonly row: RowOf<'worked'> }) {
	const ctx = useChatContext();
	return (
		<Header
			action="Worked"
			detail={`for ${formatWorkedTime(row.durationMs)}`}
			detailTone="tertiary"
			open={row.open}
			expandable
			onPress={() => ctx?.onToggleWorked?.(row.turnKey, !row.open)}
		/>
	);
}

/** The live line under a running reply: what the agent is doing, and for how long. */
function WorkingRow({ row }: { readonly row: RowOf<'working'> }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 22 }}>
			<ShimmerText active color={p.fgTertiary} numberOfLines={1} style={[styles.step, { flexShrink: 1 }]}>{row.status}</ShimmerText>
			{row.since ? (
				<View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8, gap: 8 }}>
					<Text style={[styles.step, { color: p.fgQuaternary }]}>·</Text>
					<LiveTimer since={row.since} color={p.fgQuaternary} variant="step" />
				</View>
			) : null}
		</View>
	);
}

/** The agent's to-do list (`.volt-tr-todos`): a group line with its count, open on the list. */
function TodosRow({ row }: { readonly row: RowOf<'todos'> }) {
	const { p } = useTheme();
	const [open, setOpen] = useState<boolean | undefined>(undefined);
	const expanded = open ?? row.live;
	const done = row.steps.filter(s => s.state === 'done').length;
	return (
		<View>
			<Tap haptics="selection" onPress={() => setOpen(!expanded)} style={styles.header}>
				<View style={{ width: 16, marginRight: 2, alignItems: 'center' }}><Icon name="listChecks" size={13} color={p.iconTertiary} /></View>
				<Text style={[styles.step, styles.action, { color: expanded ? p.fgSecondary : p.fgTertiary }]}>To-dos</Text>
				<Text style={[styles.step, styles.detail, { color: expanded ? p.fgTertiary : p.fgQuaternary }]}>{done} of {row.steps.length} done</Text>
				<Chevron open={expanded} />
			</Tap>
			{expanded ? (
				<View style={{ gap: 2, paddingTop: 4 }}>
					{row.steps.map((step, i) => {
						const current = step.state === 'current';
						return (
							<View key={`${i}:${step.label}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
								<View style={{ width: 16, height: 22, alignItems: 'center', justifyContent: 'center' }}>
									{current && row.live ? <Spinner size={13} /> : <Icon name={step.state === 'done' ? 'checkCircle' : current ? 'circleDashed' : 'circle'} size={13} color={step.state === 'done' ? p.success : p.iconTertiary} />}
								</View>
								<ShimmerText active={current && row.live} from={p.fgTertiary} to={p.fg} color={step.state === 'done' ? p.fgQuaternary : p.fgSecondary} style={{ flex: 1, fontSize: 14, lineHeight: 22, fontWeight: '300', textDecorationLine: step.state === 'done' ? 'line-through' : 'none' }}>{step.label}</ShimmerText>
							</View>
						);
					})}
				</View>
			) : null}
		</View>
	);
}

/** The files a finished turn changed (`.volt-agent-turn-files`), with Review. */
function TurnFilesCard({ row }: { readonly row: RowOf<'turnFiles'> }) {
	const { p, dark } = useTheme();
	const ctx = useChatContext();
	const [all, setAll] = useState(false);
	const shown = all ? row.files : row.files.slice(0, 6);
	const review = () => ctx && router.push({ pathname: '/changes/[id]', params: { id: ctx.chatId, ...(row.turnId ? { turn: row.turnId } : {}) } });
	return (
		<View style={{ marginTop: 10, marginBottom: 2, borderRadius: 12, borderWidth: 1, borderColor: dark ? 'rgba(240,240,241,0.12)' : 'rgba(0,0,0,0.10)', backgroundColor: dark ? 'rgba(255,255,255,0.015)' : 'rgba(0,0,0,0.015)' }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 8, paddingHorizontal: 12, minHeight: 28 }}>
				<Text numberOfLines={1} style={{ flex: 1, fontSize: 13, lineHeight: 20, color: p.fgTertiary }}>{row.files.length === 1 ? '1 file changed' : `${row.files.length} files changed`}</Text>
				{ctx ? (
					<Tap haptics="selection" onPress={review} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 24, paddingLeft: 10, paddingRight: 7, borderRadius: 999, backgroundColor: dark ? 'rgba(240,240,241,0.05)' : 'rgba(0,0,0,0.04)' }}>
						<Text style={{ fontSize: 12, lineHeight: 20, color: p.fgTertiary }}>Review</Text>
						<Icon name="arrowRight" size={12} color={p.fgTertiary} />
					</Tap>
				) : null}
			</View>
			<View style={{ marginHorizontal: 6, marginTop: 4, marginBottom: 6 }}>
				{shown.map(file => {
					const dir = dirname(file.path);
					return (
						<Tap key={file.path} haptics="selection" onPress={() => file.verb !== 'Deleted' ? openFile(file.path) : review()} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 6, borderRadius: 6 }}>
							<FileIcon path={file.path} size={16} />
							<Text numberOfLines={1} style={{ fontSize: 13, color: file.verb === 'Deleted' ? p.fgQuaternary : p.fgSecondary, textDecorationLine: file.verb === 'Deleted' ? 'line-through' : 'none', flexShrink: 0, maxWidth: '60%' }}>{basename(file.path)}</Text>
							<Text numberOfLines={1} ellipsizeMode="head" style={{ fontSize: 12, color: p.fgQuaternary, flex: 1 }}>{dir}</Text>
							<Stats additions={file.additions} deletions={file.deletions} />
						</Tap>
					);
				})}
				{row.files.length > shown.length ? (
					<Tap haptics="selection" onPress={() => setAll(true)} style={{ height: 28, paddingHorizontal: 6, justifyContent: 'center' }}>
						<Text style={{ fontSize: 12, color: p.fgTertiary }}>{row.files.length - shown.length} more</Text>
					</Tap>
				) : null}
			</View>
		</View>
	);
}

//#endregion

//#region Turn end

/** Proof of done under the answer: the verdict, each item with its proof (commands copy on tap), what is left, the files changed. */
function ReceiptRow({ row }: { readonly row: RowOf<'receipt'> }) {
	const { p } = useTheme();
	const receipt = row.receipt;
	const head = receiptHeadline(receipt);
	const tone = (name: 'success' | 'danger' | 'warning' | 'muted') => name === 'success' ? p.success : name === 'danger' ? p.danger : name === 'warning' ? p.warning : p.iconTertiary;
	const section = { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderColor: p.strokeFaint, gap: 2 } as const;
	const more = receipt.changedCount - receipt.changed.length;
	return (
		<View style={[styles.card, { backgroundColor: p.card, borderColor: p.stroke, paddingHorizontal: 12, paddingVertical: 10 }]} accessibilityRole="summary" accessibilityLabel={head.title}>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
				<Icon name={head.icon} size={14} color={tone(head.tone)} />
				<Text style={{ fontSize: 14, lineHeight: 22, fontWeight: '500', color: head.tone === 'muted' ? p.fgSecondary : tone(head.tone) }}>{head.title}</Text>
				<Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', fontSize: 12, color: p.fgTertiary }}>{head.meta}</Text>
			</View>
			<View style={{ gap: 6 }}>
				{receipt.lines.map((line, i) => {
					const status = receiptStatus(line.status);
					return (
						<View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
							<View style={{ height: 20, justifyContent: 'center' }} accessibilityLabel={status.label}><Icon name={status.icon} size={13} color={tone(status.tone)} /></View>
							<View style={{ flex: 1, gap: 2 }}>
								<Text selectable style={{ fontSize: 13, lineHeight: 20, color: line.status === 'missing' || line.status === 'unavailable' ? p.fgTertiary : p.fg }}>{line.source === 'agent' ? `Agent: \u201c${line.text}\u201d` : line.text}</Text>
								{line.command ? (
									<Tap haptics="light" onPress={() => copyWithHaptic(line.command!)} accessibilityLabel={`Copy ${line.command}`} style={{ alignSelf: 'flex-start', maxWidth: '100%', borderRadius: 4, backgroundColor: p.fill, paddingHorizontal: 5 }}>
										<Text numberOfLines={1} style={{ fontFamily: FONT.mono, fontSize: 11, lineHeight: 17, color: p.fg }}>{line.command}</Text>
									</Tap>
								) : null}
								{line.detail ? <Text numberOfLines={2} style={{ fontSize: 12, lineHeight: 16, color: line.status === 'failed' ? p.fgSecondary : p.fgTertiary }}>{line.detail}</Text> : null}
							</View>
						</View>
					);
				})}
			</View>
			{receipt.review && (receipt.review.summary || receipt.review.gaps.length) ? (
				<View style={section}>
					<Text style={{ fontSize: 12, color: p.fgTertiary }}>Second opinion</Text>
					{receipt.review.summary ? <Text selectable style={{ fontSize: 13, lineHeight: 20, color: p.fg }}>{receipt.review.summary}</Text> : null}
					{receipt.review.gaps.map((gap, i) => <Text key={i} selectable style={{ fontSize: 13, lineHeight: 20, color: p.fg }}>{`\u2013 ${gap}`}</Text>)}
				</View>
			) : null}
			{receipt.open.length ? (
				<View style={section}>
					<Text style={{ fontSize: 12, color: p.fgTertiary }}>Left open</Text>
					{receipt.open.map((entry, i) => <Text key={i} selectable style={{ fontSize: 13, lineHeight: 20, color: p.fg }}>{entry}</Text>)}
				</View>
			) : null}
			{receipt.changedCount ? (
				<View style={[section, { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }]}>
					<Text style={{ fontSize: 12, color: p.fgTertiary }}>{receipt.changedCount === 1 ? '1 file changed' : `${receipt.changedCount} files changed`}</Text>
					{receipt.changed.map(path => (
						<Tap key={path} haptics="selection" onPress={() => openFile(path)} style={{ borderRadius: 5, backgroundColor: p.fill, paddingHorizontal: 6, maxWidth: 200 }}>
							<Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 20, color: p.fgSecondary }}>{basename(path)}</Text>
						</Tap>
					))}
					{more > 0 ? <Text style={{ fontSize: 12, color: p.fgQuaternary }}>{`+${more} more`}</Text> : null}
				</View>
			) : null}
		</View>
	);
}

/** A reply's footer: Copy and Retry as 20px icon buttons, then when it ended and how. */
function FooterRow({ row }: { readonly row: RowOf<'footer'> }) {
	const { p } = useTheme();
	const ctx = useChatContext();
	const [copied, setCopied] = useState(false);
	const context = !row.tokens && row.tokensUsed ? `${compactNumber(row.tokensUsed)}${row.tokensWindow ? ` / ${compactNumber(row.tokensWindow)}` : ''} context` : undefined;
	const parts = [
		row.outcome === 'stopped' ? 'Stopped' : row.outcome === 'failed' ? 'Failed' : undefined,
		row.endedAt ? relativeTime(row.endedAt) : duration(row.durationMs),
		row.model,
		row.tokens ? `${compactNumber(row.tokens)} tokens` : context,
		money(row.costUsd),
	].filter(Boolean);
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28, paddingVertical: 4 }}>
			{row.copyText ? (
				<Tap haptics="light" hitSlop={10} onPress={() => {
					copyWithHaptic(row.copyText);
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				}} style={styles.footerBtn} accessibilityLabel="Copy reply">
					<Icon name={copied ? 'check' : 'copy'} size={12} color={copied ? p.success : p.iconTertiary} />
				</Tap>
			) : null}
			{ctx && !ctx.readOnly && row.turnId ? (
				<Tap haptics="light" hitSlop={10} onPress={() => ctx.onRetry(row.turnId!)} style={styles.footerBtn} accessibilityLabel="Retry">
					<Icon name="refresh" size={12} color={p.iconTertiary} />
				</Tap>
			) : null}
			<Text numberOfLines={1} style={{ flex: 1, paddingLeft: 2, fontSize: 13, lineHeight: 18, letterSpacing: -0.08, color: p.fgQuaternary }}>{parts.join(' · ')}</Text>
		</View>
	);
}

function SystemRow({ row }: { readonly row: RowOf<'system'> }) {
	const { p } = useTheme();
	const [open, setOpen] = useState(false);
	return (
		<View>
			<Tap haptics="selection" onPress={() => setOpen(o => !o)} style={styles.header}>
				<View style={{ width: 16, marginRight: 2, alignItems: 'center' }}><Icon name={row.icon} size={13} color={p.iconTertiary} /></View>
				<Text numberOfLines={1} style={[styles.step, styles.action, { color: open ? p.fgSecondary : p.fgTertiary }]}>{row.title}</Text>
				<Chevron open={open} />
			</Tap>
			{open ? <View style={{ marginTop: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: p.fillFaint }}><Markdown text={row.body} compact /></View> : null}
		</View>
	);
}

/** A provider's error or warning (`.volt-agent-provider-notice`): a quiet card, not an alarm. */
function NoticeRow({ row }: { readonly row: RowOf<'notice'> }) {
	const { p } = useTheme();
	const error = row.severity === 'error';
	return (
		<View style={error ? { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: p.card, borderWidth: 1, borderColor: p.strokeFaint } : { flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
			{error ? null : <View style={{ height: 22, justifyContent: 'center' }}><Icon name={row.severity === 'warning' ? 'alert' : 'info'} size={13} color={row.severity === 'warning' ? p.warning : p.iconTertiary} /></View>}
			<View style={{ flex: 1 }}>
				<Text selectable style={{ fontSize: 13, lineHeight: error ? 20 : 22, letterSpacing: -0.08, color: error ? p.fg : p.fgTertiary }}>{row.title}</Text>
				{row.description ? <Text selectable style={{ marginTop: 2, fontSize: 13, lineHeight: 18, letterSpacing: -0.08, color: error ? p.fgSecondary : p.fgQuaternary }}>{row.description}</Text> : null}
			</View>
		</View>
	);
}

//#endregion

export const RowView = memo(function RowView({ row, chatId }: { readonly row: TranscriptRow; readonly chatId: string }): ReactNode {
	const { p } = useTheme();
	switch (row.kind) {
		case 'user':
			return <UserRow row={row} chatId={chatId} />;
		case 'markdown':
			return <Markdown text={row.text} docKey={row.docKey} streaming={row.streaming} />;
		case 'thought':
			return <ThoughtLine text={row.text} detail={row.durationMs && row.durationMs >= 1000 ? `${Math.round(row.durationMs / 1000)}s` : 'briefly'} live={row.streaming} />;
		case 'steps':
			return <StepsRow row={row} />;
		case 'file':
			return <EditCard row={row} />;
		case 'subagents':
			return <SubagentsRow row={row} />;
		case 'compaction':
			return <CompactionRow row={row} />;
		case 'worked':
			return <WorkedRow row={row} />;
		case 'turnFiles':
			return <TurnFilesCard row={row} />;
		case 'code':
			return <CodeBlock code={row.code} lang={row.lang} path={row.path} streaming={row.streaming} />;
		case 'table':
			return <TableView header={row.headers} rows={row.rows} />;
		case 'plan':
			return (
				<View style={[styles.card, { backgroundColor: p.card, borderColor: p.stroke, padding: 14 }]}>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8 }}>
						<Icon name="book" size={14} color={p.iconTertiary} />
						<ShimmerText active={row.streaming} color={p.fgSecondary} numberOfLines={1} style={{ flex: 1, fontSize: 13, lineHeight: 20, fontWeight: '500' }}>{row.title}</ShimmerText>
					</View>
					<Markdown text={row.markdown} docKey={row.docKey} streaming={row.streaming} />
					{row.openQuestions?.length ? (
						<View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderColor: p.strokeFaint, gap: 4 }}>
							<Text style={{ fontSize: 13, fontWeight: '500', color: p.fgSecondary }}>Open questions</Text>
							{row.openQuestions.map(q => <Inline key={q} text={`• ${q}`} size={14} style={{ color: p.fgSecondary, lineHeight: 22, fontWeight: '300' }} />)}
						</View>
					) : null}
				</View>
			);
		case 'decision':
			return (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22 }}>
					<Icon name="shieldAlert" size={13} color={p.warning} />
					<Text numberOfLines={1} style={[styles.step, { color: p.fgTertiary }]}>Waiting for approval</Text>
					<Text numberOfLines={1} style={[styles.step, { color: p.fgQuaternary, flexShrink: 1, fontFamily: FONT.mono, fontSize: 12 }]}>{row.resource}</Text>
				</View>
			);
		case 'answers':
			return (
				<View style={[styles.card, { backgroundColor: p.card, borderColor: p.stroke, paddingHorizontal: 12, paddingVertical: 10, gap: 6 }]}>
					<Text style={{ fontSize: 13, lineHeight: 20, color: p.fgTertiary }}>{row.outcome === 'answered' ? 'Answered' : row.outcome === 'skipped' ? 'Skipped' : 'Dismissed'}</Text>
					{row.items.map((item, i) => (
						<View key={i} style={{ gap: 1 }}>
							<Text style={{ fontSize: 13, lineHeight: 18, color: p.fgTertiary }}>{item.question}</Text>
							<Text selectable style={{ fontSize: 14, lineHeight: 22, fontWeight: '300', color: p.fg }}>{item.answer}</Text>
						</View>
					))}
					{row.note ? <Text style={{ fontSize: 13, lineHeight: 18, color: p.fgSecondary }}>{row.note}</Text> : null}
				</View>
			);
		case 'receipt':
			return <ReceiptRow row={row} />;
		case 'notice':
			return <NoticeRow row={row} />;
		case 'error':
			return (
				<View style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: p.card, borderWidth: 1, borderColor: `${p.danger}55`, gap: 2 }}>
					<Text selectable style={{ fontSize: 13, lineHeight: 20, letterSpacing: -0.08, color: p.fg }}>{row.message}</Text>
				</View>
			);
		case 'todos':
			return <TodosRow row={row} />;
		case 'chart': {
			const max = Math.max(1, ...row.values.map(v => Math.abs(v)));
			return (
				<View style={[styles.card, { backgroundColor: p.card, borderColor: p.stroke, padding: 14, gap: 8 }]}>
					{row.title ? <Text style={{ fontSize: 13, fontWeight: '500', color: p.fgSecondary, marginBottom: 2 }}>{row.title}</Text> : null}
					{row.labels.map((label, i) => (
						<View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
							<Text numberOfLines={1} style={{ width: 96, fontSize: 12, color: p.fgSecondary }}>{label}</Text>
							<View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: p.fill, overflow: 'hidden' }}>
								<View style={{ width: `${(Math.abs(row.values[i] ?? 0) / max) * 100}%`, height: 8, borderRadius: 4, backgroundColor: p.info }} />
							</View>
							<Text style={{ fontSize: 12, color: p.fgTertiary, fontVariant: ['tabular-nums'] }}>{compactNumber(row.values[i])}{row.unit ?? ''}</Text>
						</View>
					))}
				</View>
			);
		}
		case 'cards':
			return (
				<View style={{ gap: 8 }}>
					{row.items.map((item, i) => (
						<View key={i} style={[styles.card, { backgroundColor: p.card, borderColor: p.stroke, padding: 12 }]}>
							<Text style={{ fontSize: 14, lineHeight: 22, fontWeight: '500', color: p.fg }}>{item.title}</Text>
							<Inline text={item.body} size={13} style={{ color: p.fgSecondary, lineHeight: 20, fontWeight: '300' }} />
							{item.meta ? <Text style={{ fontSize: 12, color: p.fgQuaternary, marginTop: 6 }}>{item.meta}</Text> : null}
						</View>
					))}
				</View>
			);
		case 'visual':
			return <VisualCard visualRef={row.ref} kind={row.visual} title={row.title} {...(row.height ? { height: row.height } : {})} {...(row.detail ? { detail: row.detail } : {})} {...(row.pending ? { pending: true } : {})} />;
		case 'working':
			return <WorkingRow row={row} />;
		case 'footer':
			return <FooterRow row={row} />;
		case 'divider':
			return (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 24 }}>
					<View style={{ flex: 1, height: 1, backgroundColor: p.stroke }} />
					{row.live ? <Spinner size={12} /> : <Icon name={row.icon} size={12} color={p.iconTertiary} />}
					<Text numberOfLines={1} style={{ maxWidth: '72%', fontSize: 13, lineHeight: 20, color: p.fgTertiary }}>{row.label}{row.detail ? <Text style={{ color: p.fgQuaternary }}>{` ${row.detail}`}</Text> : null}</Text>
					<View style={{ flex: 1, height: 1, backgroundColor: p.stroke }} />
				</View>
			);
		case 'system':
			return <SystemRow row={row} />;
	}
});

/** Prompts and dividers span the column; everything the agent wrote sits 13px in, under the prompt's text. */
export function rowInset(row: TranscriptRow): number {
	return row.kind === 'user' || row.kind === 'divider' || row.kind === 'compaction' ? 0 : 13;
}

/**
 * Space above a row (agentEditor.css): 20px between one turn and the next prompt, 6px from a
 * prompt to its reply, 14px between the rows of a reply; the footer sits right under the reply.
 */
export function rowGap(row: TranscriptRow, prev: TranscriptRow | undefined): number {
	if (!prev) {
		return 0;
	}
	if (row.kind === 'user' || (row.kind === 'divider' && prev.kind !== 'user') || row.kind === 'system') {
		return prev.kind === 'divider' ? 8 : 20;
	}
	if (prev.kind === 'user' || prev.kind === 'divider') {
		return 6;
	}
	if (row.kind === 'footer') {
		return 4;
	}
	if (row.kind === 'turnFiles') {
		return 0;
	}
	return 14;
}

const styles = StyleSheet.create({
	step: { fontSize: STEP.size, lineHeight: STEP.line },
	header: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: STEP.line, alignSelf: 'stretch' },
	action: { fontWeight: '300', flexShrink: 0 },
	detail: { flexShrink: 1, minWidth: 0 },
	exit: { marginLeft: 6, fontSize: 12, opacity: 0.8 },
	card: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
	editHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 10 },
	terminal: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
	termText: { fontSize: 13, lineHeight: 18 },
	termCommand: { paddingTop: 6, paddingBottom: 6, paddingLeft: 10, paddingRight: 32 },
	termOutput: { paddingHorizontal: 10, paddingBottom: 6 },
	termMenu: { position: 'absolute', top: 6, right: 6, width: 20, height: 20, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
	// agentEditor.css `.volt-agent-turn.user .volt-agent-bubble`: 8px radius, a 1px edge, 8/12 padding.
	prompt: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
	promptMain: { flex: 1, minWidth: 0, gap: 6 },
	userStop: { position: 'absolute', right: 5, bottom: 5, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
	userMode: { alignSelf: 'flex-start', paddingHorizontal: 7, borderRadius: 6 },
	userText: { fontSize: 14, lineHeight: 22, fontWeight: '300' },
	readMore: { position: 'absolute', bottom: 0, flexDirection: 'row', alignItems: 'center', height: 22 },
	chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
	chip: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 22, paddingHorizontal: 6, borderRadius: 6, maxWidth: '100%' },
	footerBtn: { width: 20, height: 20, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
});
