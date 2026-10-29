/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	highlight, type IVoltPalette, markdownFor, type MdBlock, type MdCallout, type MdInline, parseInline, parseMarkdown, RADIUS, resolveLanguage, stripHtml, texToText
} from '@volt/client-core';
import * as Clipboard from 'expo-clipboard';
import { Fragment, memo, type ReactNode, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Image, Linking, Platform, ScrollView, StyleSheet, Text, type TextStyle, useWindowDimensions, View } from 'react-native';
import { FileIcon } from '../files/FileIcon';
import { useConversationPrefs } from '../state/prefs';
import { FONT, useTheme } from '../theme/theme';
import { haptic, Icon, T, Tap } from '../ui/core';
import { showImage } from '../ui/ImageViewer';
import { openFile, resolveFileLink, useChatContext } from './context';
import { TrDiff } from './TrDiff';
import { ChartFenceBlock, MathBlock, MermaidBlock } from './Visuals';

/** Inline math reads as math: a serif face, as KaTeX sets it. */
const MATH_FONT = Platform.select({ ios: 'Times New Roman', android: 'serif', default: '"Times New Roman", serif' });

/**
 * Markdown as native text, set as the desktop sets a reply (agentMarkdown.css): 14/22 in the
 * light face, paragraphs 4px above and 8px below, headings a step up at weight 500, lists 30px in
 * with 8px between items, inline code 12.5px mono on an 8% fill, file paths as link-blue pills.
 * A paragraph is one `<Text>` with nested spans (one attributed string, selectable). Blocks are
 * memoized on identity: while a reply streams, `markdownFor` reuses every finished block and
 * only the block being written re-renders.
 */

/** `reply` is a reply; `thinking` the reasoning under "Thought" (13/21, tertiary); `compact` a card's body. */
export type MarkdownTone = 'reply' | 'thinking' | 'compact';

interface IFace {
	readonly size: number;
	readonly line: number;
	readonly color: string;
	readonly weight: TextStyle['fontWeight'];
	/** Space after a paragraph. */
	readonly after: number;
}

function faceFor(tone: MarkdownTone, p: IVoltPalette): IFace {
	switch (tone) {
		case 'thinking': return { size: 13, line: 21, color: p.fgTertiary, weight: '400', after: 16 };
		case 'compact': return { size: 13, line: 20, color: p.fg, weight: '300', after: 6 };
		default: return { size: 14, line: 22, color: p.fg, weight: '300', after: 8 };
	}
}

interface IInlineContext {
	readonly p: IVoltPalette;
	readonly size: number;
	/** The chat's folder: file paths in replies open in the file viewer. */
	readonly folder?: string;
}

/** A path-looking inline code span (`src/app.ts`, `app.ts:12`) that opens the file. */
const CODE_PATH = /^(?:\/|\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+(?::\d+)?$/;

function renderInlines(nodes: readonly MdInline[], ctx: IInlineContext, key = ''): ReactNode[] {
	return nodes.map((node, i) => {
		const k = `${key}${i}`;
		switch (node.t) {
			case 'text':
				return node.v;
			case 'br':
				return '\n';
			case 'math':
				return <Text key={k} style={{ fontFamily: MATH_FONT, fontSize: ctx.size + 1, color: ctx.p.fg }}>{texToText(node.v)}</Text>;
			case 'code': {
				const file = CODE_PATH.test(node.v) ? resolveFileLink(node.v, ctx.folder) : undefined;
				// A file that opens on tap: link-blue on a light-blue chip, as in Cursor.
				return (
					<Text
						key={k}
						onPress={file ? () => openFile(file.path, file.line) : undefined}
						suppressHighlighting={!file}
						style={{ fontFamily: FONT.mono, fontSize: ctx.size - 1.5, fontWeight: '400', color: file ? ctx.p.link : ctx.p.fg, backgroundColor: file ? `${ctx.p.link}24` : ctx.p.fill }}
					>
						{` ${node.v} `}
					</Text>
				);
			}
			case 'strong':
				return <Text key={k} style={styles.strong}>{renderInlines(node.c, ctx, `${k}.`)}</Text>;
			case 'em':
				return <Text key={k} style={styles.em}>{renderInlines(node.c, ctx, `${k}.`)}</Text>;
			case 'del':
				return <Text key={k} style={{ textDecorationLine: 'line-through', color: ctx.p.fgTertiary }}>{renderInlines(node.c, ctx, `${k}.`)}</Text>;
			case 'image':
				return <Text key={k} style={{ color: ctx.p.link, fontWeight: '500' }} onPress={() => /^(https?:|data:image\/)/i.test(node.src) ? showImage(node.src, node.alt) : void Linking.openURL(node.src).catch(() => undefined)}>{`[${node.alt || 'image'}]`}</Text>;
			case 'link': {
				const href = /^(https?:|mailto:)/i.test(node.href) ? node.href : undefined;
				const file = href ? undefined : resolveFileLink(node.href, ctx.folder);
				const onPress = href ? () => void Linking.openURL(href).catch(() => undefined) : file ? () => openFile(file.path, file.line) : undefined;
				// Links: medium weight in the link colour.
				return (
					<Text key={k} style={href || file ? { color: ctx.p.link, fontWeight: '500' } : { textDecorationLine: 'underline', textDecorationColor: ctx.p.fgQuaternary }} onPress={onPress} suppressHighlighting={false}>
						{renderInlines(node.c, ctx, `${k}.`)}
					</Text>
				);
			}
		}
	});
}

export function Inline({ text, open, style, size = 14 }: { readonly text: string; readonly open?: boolean; readonly style?: TextStyle; readonly size?: number }) {
	const { p } = useTheme();
	const folder = useChatContext()?.folder;
	return <Text style={[{ color: p.fg, fontSize: size }, style]}>{renderInlines(parseInline(text, open), { p, size, ...(folder ? { folder } : {}) })}</Text>;
}

/** A picture on its own line in a reply: drawn at its aspect ratio, opened full screen on tap. */
function MarkdownImage({ src, alt }: { readonly src: string; readonly alt: string }) {
	const { p } = useTheme();
	const { width: screen } = useWindowDimensions();
	const [ratio, setRatio] = useState<number | undefined>();
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let live = true;
		Image.getSize(src, (w, h) => {
			if (live && h > 0) {
				setRatio(w / h);
			}
		}, () => {
			if (live) {
				setFailed(true);
			}
		});
		return () => {
			live = false;
		};
	}, [src]);
	if (failed) {
		// A picture that didn't load: what it was, and its address to open elsewhere.
		return (
			<Tap haptics="light" onPress={() => void Linking.openURL(src).catch(() => undefined)} accessibilityLabel={`${alt || 'Image'} (not loaded)`} style={{ marginVertical: 6, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: RADIUS.md, backgroundColor: p.fillFaint, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, maxWidth: '100%' }}>
				<Icon name="image" size={16} color={p.fgTertiary} />
				<View style={{ flexShrink: 1 }}>
					<T variant="small" numberOfLines={1}>{alt || 'Image'}</T>
					<T variant="caption" color={p.fgTertiary} numberOfLines={1}>{src.replace(/^https?:\/\//, '')}</T>
				</View>
			</Tap>
		);
	}
	const width = Math.min(screen - 56, 520);
	return (
		<Tap haptics="light" onPress={() => showImage(src, alt)} accessibilityLabel={alt || 'Image'} style={{ marginVertical: 8, alignSelf: 'flex-start', borderRadius: 8, overflow: 'hidden', backgroundColor: p.fill, borderWidth: 1, borderColor: p.strokeFaint }}>
			<Image source={{ uri: src }} style={{ width, height: ratio ? Math.min(width / ratio, 480) : 180 }} resizeMode="contain" accessibilityIgnoresInvertColors />
		</Tap>
	);
}

/** Headings: a step above the 14px body, not a display size (agentMarkdown.css). */
const HEADING: Record<number, { readonly size: number; readonly line: number }> = { 1: { size: 18, line: 26 }, 2: { size: 16.5, line: 24 }, 3: { size: 15.5, line: 22 }, 4: { size: 15, line: 22 }, 5: { size: 14, line: 22 }, 6: { size: 14, line: 22 } };
const CALLOUT_ICON: Record<MdCallout, Parameters<typeof Icon>[0]['name']> = { note: 'info', tip: 'sparkles', important: 'alertCircle', warning: 'alert', caution: 'xCircle' };
/** Bullets by depth: disc, circle, square. */
const BULLETS = ['•', '◦', '▪'];

const BlockView = memo(function BlockView({ block, open, depth, tone, first, last }: { readonly block: MdBlock; readonly open: boolean; readonly depth: number; readonly tone: MarkdownTone; readonly first: boolean; readonly last: boolean }): ReactNode {
	const { p } = useTheme();
	const folder = useChatContext()?.folder;
	const face = faceFor(tone, p);
	const ctx: IInlineContext = { p, size: face.size, ...(folder ? { folder } : {}) };
	const top = (n: number) => first ? 0 : n;
	const bottom = (n: number) => last ? 0 : n;
	switch (block.type) {
		case 'paragraph': {
			const only = open ? undefined : soleImage(block.text);
			if (only) {
				return <MarkdownImage src={only.src} alt={only.alt} />;
			}
			return <Paragraph text={block.text} open={open && tone === 'reply'} ctx={ctx} face={face} style={{ marginTop: top(depth ? 0 : 4), marginBottom: bottom(depth ? 0 : face.after) }} />;
		}
		case 'heading': {
			const h = tone === 'reply' ? HEADING[block.level] ?? HEADING[4] : { size: face.size, line: face.line };
			return (
				<Text selectable accessibilityRole="header" style={{ color: tone === 'thinking' ? face.color : p.fg, fontSize: h.size, lineHeight: h.line, fontWeight: '500', marginTop: top(tone === 'reply' ? 22 : 10), marginBottom: bottom(4) }}>
					{renderInlines(parseInline(block.text, open), { ...ctx, size: h.size })}
				</Text>
			);
		}
		case 'code':
			return <View style={{ marginTop: top(12), marginBottom: bottom(12) }}><CodeBlock code={block.code} lang={block.lang} streaming={open && !block.closed} /></View>;
		case 'math':
			return open ? (
				<View style={{ marginVertical: 6, padding: 12, borderRadius: RADIUS.md, backgroundColor: p.fillFaint }}>
					<Text selectable style={{ fontFamily: FONT.mono, fontSize: 13, color: p.fgTertiary }}>{block.text}</Text>
				</View>
			) : <MathBlock tex={block.text} />;
		case 'hr':
			return <View style={{ height: 1, backgroundColor: p.stroke, marginTop: top(16), marginBottom: bottom(16) }} />;
		case 'html':
			return <Text selectable style={{ color: p.fgSecondary, fontSize: face.size, lineHeight: face.line, fontWeight: face.weight, marginBottom: bottom(face.after) }}>{stripHtml(block.text)}</Text>;
		case 'quote':
			return block.callout ? (
				<View style={{ marginTop: top(8), marginBottom: bottom(8), paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: p.fillFaint, borderWidth: 1, borderColor: p.strokeFaint }}>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
						<Icon name={CALLOUT_ICON[block.callout]} size={13} color={block.callout === 'warning' || block.callout === 'caution' ? p.warning : block.callout === 'tip' ? p.success : p.info} />
						<Text style={{ fontSize: 13, lineHeight: 20, fontWeight: '500', color: p.fgSecondary, textTransform: 'capitalize' }}>{block.callout}</Text>
					</View>
					<Blocks blocks={block.blocks} open={open} depth={depth + 1} tone={tone} />
				</View>
			) : (
				// A blockquote: 16px in, a 3px rounded bar in the stroke colour, secondary text.
				<View style={{ marginTop: top(8), marginBottom: bottom(8), paddingVertical: 2, paddingLeft: 16 }}>
					<View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, borderRadius: 2, backgroundColor: p.stroke }} />
					<View style={{ opacity: 0.86 }}><Blocks blocks={block.blocks} open={open} depth={depth + 1} tone={tone} /></View>
				</View>
			);
		case 'list':
			return (
				<View style={{ marginTop: top(depth ? 8 : 8), marginBottom: bottom(depth ? 0 : 18), gap: block.tight ? 8 : 8 }}>
					{block.items.map((item, i) => (
						<View key={item.key} style={{ flexDirection: 'row' }}>
							<View style={{ width: item.checked !== undefined ? 22 : 30, alignItems: item.checked !== undefined ? 'flex-start' : 'flex-end', paddingRight: item.checked !== undefined ? 0 : 8 }}>
								{item.checked !== undefined ? (
									<View style={{ height: face.line, justifyContent: 'center' }}>
										<Icon name={item.checked ? 'checkCircle' : 'circle'} size={14} color={item.checked ? p.success : p.iconTertiary} />
									</View>
								) : (
									<Text style={{ color: block.ordered ? face.color : p.fgTertiary, fontSize: face.size, lineHeight: face.line, fontWeight: face.weight, fontVariant: ['tabular-nums'] }}>
										{block.ordered ? `${block.start + i}.` : BULLETS[depth % 3]}
									</Text>
								)}
							</View>
							<View style={{ flex: 1, minWidth: 0 }}>
								<Blocks blocks={item.blocks} open={open && i === block.items.length - 1} depth={depth + 1} tone={tone} />
							</View>
						</View>
					))}
				</View>
			);
		case 'table':
			return <View style={{ marginTop: top(8), marginBottom: bottom(12) }}><TableView header={block.header} rows={block.rows} align={block.align} /></View>;
	}
}, (a, b) => a.block === b.block && a.open === b.open && a.depth === b.depth && a.tone === b.tone && a.first === b.first && a.last === b.last);

/** How long streamed text keeps its fresh tint before it settles to the text colour. */
const FRESH_MS = 520;

/**
 * Streamed reply text arrives light blue and settles to the text colour (agentFreshText.ts): the
 * characters added since the last frame are tinted until the next one, or for a moment once the
 * stream pauses. Only plain text at the paragraph's end is tinted, so inline markup still parses.
 */
function Paragraph({ text, open, ctx, face, style }: { readonly text: string; readonly open: boolean; readonly ctx: IInlineContext; readonly face: IFace; readonly style: TextStyle }) {
	const { dark } = useTheme();
	const seen = useRef(text.length);
	const freshFrom = useRef(text.length);
	if (!open) {
		seen.current = freshFrom.current = text.length;
	} else if (text.length > seen.current) {
		freshFrom.current = seen.current;
		seen.current = text.length;
	}
	const [, settle] = useReducer((n: number) => n + 1, 0);
	const fresh = open ? Math.min(160, text.length - freshFrom.current) : 0;
	useEffect(() => {
		if (!fresh) {
			return;
		}
		const timer = setTimeout(() => {
			freshFrom.current = seen.current;
			settle();
		}, FRESH_MS);
		return () => clearTimeout(timer);
	}, [text, fresh]);
	const nodes = parseInline(text, open);
	return (
		<Text selectable style={[{ color: face.color, fontSize: face.size, lineHeight: face.line, fontWeight: face.weight }, style]}>
			{fresh ? renderFresh(nodes, fresh, ctx, dark ? '#C2DCFF' : '#5B95E6') : renderInlines(nodes, ctx)}
		</Text>
	);
}

/** The inlines with their last `count` characters of trailing plain text in `color`. */
function renderFresh(nodes: readonly MdInline[], count: number, ctx: IInlineContext, color: string): ReactNode[] {
	let split = nodes.length;
	let left = count;
	const tail: string[] = [];
	while (split > 0 && left > 0) {
		const node = nodes[split - 1];
		if (node.t !== 'text') {
			break;
		}
		if (node.v.length <= left) {
			tail.unshift(node.v);
			left -= node.v.length;
			split--;
		} else {
			tail.unshift(node.v.slice(node.v.length - left));
			const head: MdInline = { t: 'text', v: node.v.slice(0, node.v.length - left) };
			return [...renderInlines([...nodes.slice(0, split - 1), head], ctx), <Text key="fresh" style={{ color }}>{tail.join('')}</Text>];
		}
	}
	return tail.length ? [...renderInlines(nodes.slice(0, split), ctx), <Text key="fresh" style={{ color }}>{tail.join('')}</Text>] : renderInlines(nodes, ctx);
}

function Blocks({ blocks, open, depth, tone }: { readonly blocks: readonly MdBlock[]; readonly open: boolean; readonly depth: number; readonly tone: MarkdownTone }) {
	return (
		<>
			{blocks.map((block, i) => <BlockView key={block.key} block={block} open={open && i === blocks.length - 1} depth={depth} tone={tone} first={i === 0} last={i === blocks.length - 1} />)}
		</>
	);
}

/** The image when a paragraph is nothing but one (`![alt](https://…)`). */
function soleImage(text: string): { readonly src: string; readonly alt: string } | undefined {
	const nodes = parseInline(text.trim()).filter(node => !(node.t === 'text' && !node.v.trim()));
	const node = nodes.length === 1 ? nodes[0] : undefined;
	if (node?.t === 'image' && /^(https?:|data:image\/)/i.test(node.src)) {
		return { src: node.src, alt: node.alt };
	}
	const inner = node?.t === 'link' && node.c.length === 1 ? node.c[0] : undefined;
	if (inner?.t === 'image' && /^(https?:|data:image\/)/i.test(inner.src)) {
		return { src: inner.src, alt: inner.alt };
	}
	return undefined;
}

export const Markdown = memo(function Markdown({ text, docKey, streaming = false, compact, tone }: { readonly text: string; readonly docKey?: string; readonly streaming?: boolean; readonly compact?: boolean; readonly tone?: MarkdownTone }) {
	const doc = useMemo(() => docKey ? markdownFor(docKey, text) : parseMarkdown(text), [docKey, text]);
	return <View><Blocks blocks={doc.blocks} open={streaming} depth={0} tone={tone ?? (compact ? 'compact' : 'reply')} /></View>;
});

export function TableView({ header, rows, align }: { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly align?: readonly ('left' | 'center' | 'right' | null)[] }) {
	const { p } = useTheme();
	const widths = useMemo(() => header.map((h, c) => {
		const longest = Math.max(h.length, ...rows.map(r => (r[c] ?? '').length));
		return Math.min(260, Math.max(72, longest * 7 + 24));
	}), [header, rows]);
	const cell = (text: string, c: number, head: boolean) => (
		<View key={c} style={{ width: widths[c], paddingHorizontal: 12, paddingVertical: 8, borderLeftWidth: c ? 1 : 0, borderColor: p.strokeFaint }}>
			<Inline text={text} size={13} style={{ lineHeight: 20, fontWeight: head ? '500' : '300', color: head ? p.fgSecondary : p.fg, textAlign: align?.[c] ?? 'left' }} />
		</View>
	);
	return (
		<View style={{ borderRadius: 8, borderWidth: 1, borderColor: p.stroke, overflow: 'hidden', backgroundColor: p.card }}>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
				<View>
					<View style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: p.stroke, backgroundColor: p.fillFaint }}>{header.map((h, c) => cell(h, c, true))}</View>
					{rows.map((row, r) => (
						<View key={r} style={{ flexDirection: 'row', borderBottomWidth: r === rows.length - 1 ? 0 : 1, borderColor: p.strokeFaint }}>
							{header.map((_, c) => cell(row[c] ?? '', c, false))}
						</View>
					))}
				</View>
			</ScrollView>
		</View>
	);
}

const COLLAPSE_LINES = 60;

/** A fenced block: a diagram when it is mermaid (once it has finished streaming in), else highlighted code. */
export const CodeBlock = memo(function CodeBlock(props: { readonly code: string; readonly lang?: string; readonly path?: string; readonly streaming?: boolean }) {
	if (!props.streaming && !props.path && props.lang?.toLowerCase() === 'mermaid' && props.code.trim()) {
		return <MermaidBlock source={props.code} fallback={<CodeCard {...props} />} />;
	}
	if (!props.streaming && !props.path && props.lang?.toLowerCase() === 'volt-chart' && props.code.trim()) {
		return <ChartFenceBlock spec={props.code} fallback={<CodeCard {...props} />} />;
	}
	return <CodeCard {...props} />;
});

/**
 * The desktop's code card (`.volt-md-code-block`): the editor's colour, a 1px stroke, 12px
 * corners, 12/18 mono with 6px above and below and 10px at the sides, Copy in the top-right
 * corner. A cited snippet (a path) gets the 31px header with its file icon and name.
 */
const CodeCard = memo(function CodeCard({ code, lang, path, streaming }: { readonly code: string; readonly lang?: string; readonly path?: string; readonly streaming?: boolean }) {
	const { p } = useTheme();
	const { codeWrap } = useConversationPrefs();
	const [copied, setCopied] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const isDiff = !streaming && resolveLanguage(lang) === 'diff' && /^@@ /m.test(code);
	const all = useMemo(() => isDiff ? [] : highlight(code, lang), [code, lang, isDiff]);
	const long = !streaming && all.length > COLLAPSE_LINES;
	const lines = long && !expanded ? all.slice(0, COLLAPSE_LINES - 20) : all;
	const text = (
		<Text selectable style={{ fontFamily: FONT.mono, fontSize: 12, lineHeight: 18, color: p.syntax.plain, paddingHorizontal: 10, paddingVertical: 6, paddingRight: path ? 10 : 34 }}>
			{lines.map((tokens, i) => (
				<Fragment key={i}>
					{tokens.map((token, j) => token.k === 'plain' ? token.v : <Text key={j} style={{ color: p.syntax[token.k], ...(token.k === 'comment' ? styles.em : {}) }}>{token.v}</Text>)}
					{i < lines.length - 1 ? '\n' : ''}
				</Fragment>
			))}
		</Text>
	);
	const copy = (
		<Tap haptics="light" hitSlop={8} onPress={() => {
			void Clipboard.setStringAsync(code);
			setCopied(true);
			setTimeout(() => setCopied(false), 1400);
		}} style={{ width: 22, height: 22, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Copy code">
			<Icon name={copied ? 'check' : 'copy'} size={14} color={copied ? p.success : p.fgSecondary} />
		</Tap>
	);
	return (
		<View style={{ borderRadius: 12, borderWidth: 1, borderColor: p.stroke, backgroundColor: p.card, overflow: 'hidden' }}>
			{path ? (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 31, paddingHorizontal: 10, borderBottomWidth: 1, borderColor: p.strokeFaint }}>
					<FileIcon path={path} size={16} />
					<Text numberOfLines={1} onPress={() => openFile(path)} style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: p.fgSecondary }}>{path.split('/').pop()}</Text>
					<View style={{ flex: 1 }} />
					{copy}
				</View>
			) : null}
			{isDiff ? <TrDiff diff={code} /> : codeWrap ? text : (
				<ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
					{text}
				</ScrollView>
			)}
			{path ? null : <View style={{ position: 'absolute', top: 4, right: 4 }}>{copy}</View>}
			{long ? (
				<Tap haptics="selection" onPress={() => setExpanded(e => !e)} style={{ height: 34, alignItems: 'center', justifyContent: 'center', borderTopWidth: 1, borderColor: p.strokeFaint }}>
					<Text style={{ fontSize: 12, fontWeight: '500', color: p.fgTertiary }}>{expanded ? 'Show less' : `Show all ${all.length} lines`}</Text>
				</Tap>
			) : null}
		</View>
	);
});

export function copyWithHaptic(text: string): void {
	void Clipboard.setStringAsync(text);
	haptic.light();
}

const styles = StyleSheet.create({
	strong: { fontWeight: '500' },
	em: { fontStyle: 'italic' },
});
