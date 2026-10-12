/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	highlight, type IVoltPalette, languageLabel, markdownFor, type MdBlock, type MdCallout, type MdInline, parseInline, parseMarkdown, RADIUS, resolveLanguage, stripHtml, TYPE
} from '@volt/client-core';
import * as Clipboard from 'expo-clipboard';
import { Fragment, memo, type ReactNode, useEffect, useMemo, useState } from 'react';
import { Image, Linking, ScrollView, StyleSheet, Text, type TextStyle, useWindowDimensions, View } from 'react-native';
import { haptic, Icon, T, Tap } from '../ui/core';
import { showImage } from '../ui/ImageViewer';
import { FONT, useTheme } from '../theme/theme';
import { openFile, resolveFileLink, useChatContext } from './context';
import { InlineDiff } from './Diff';

/**
 * Markdown as native text. A paragraph is one `<Text>` with nested spans (one attributed string,
 * selectable), so a long reply costs a handful of views, not one per word. Blocks are memoized on
 * identity: while a reply streams, `markdownFor` reuses every finished block and only the block
 * being written re-renders.
 */

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
			case 'code': {
				const file = CODE_PATH.test(node.v) ? resolveFileLink(node.v, ctx.folder) : undefined;
				return (
					<Text key={k} onPress={file ? () => openFile(file.path, file.line) : undefined} suppressHighlighting={!file} style={{ fontFamily: FONT.mono, fontSize: ctx.size - 2, color: file ? ctx.p.link : ctx.p.fg, backgroundColor: ctx.p.fill }}>
						{`\u2009${node.v}\u2009`}
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
				return <Text key={k} style={{ color: ctx.p.link }} onPress={() => /^(https?:|data:image\/)/i.test(node.src) ? showImage(node.src, node.alt) : void Linking.openURL(node.src).catch(() => undefined)}>{`[${node.alt || 'image'}]`}</Text>;
			case 'link': {
				const href = /^(https?:|mailto:)/i.test(node.href) ? node.href : undefined;
				const file = href ? undefined : resolveFileLink(node.href, ctx.folder);
				const onPress = href ? () => void Linking.openURL(href).catch(() => undefined) : file ? () => openFile(file.path, file.line) : undefined;
				return (
					<Text key={k} style={href || file ? { color: ctx.p.link } : { textDecorationLine: 'underline', textDecorationColor: ctx.p.fgQuaternary }} onPress={onPress} suppressHighlighting={false}>
						{renderInlines(node.c, ctx, `${k}.`)}
					</Text>
				);
			}
		}
	});
}

export function Inline({ text, open, style, size = TYPE.reading.size }: { readonly text: string; readonly open?: boolean; readonly style?: TextStyle; readonly size?: number }) {
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
		return <Text style={{ color: p.link, marginVertical: 4 }} onPress={() => void Linking.openURL(src).catch(() => undefined)}>{`[${alt || 'image'}]`}</Text>;
	}
	const width = Math.min(screen - 40, 520);
	return (
		<Tap haptics="light" onPress={() => showImage(src, alt)} accessibilityLabel={alt || 'Image'} style={{ marginVertical: 8, alignSelf: 'flex-start', borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: p.fill, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
			<Image source={{ uri: src }} style={{ width, height: ratio ? Math.min(width / ratio, 480) : 180 }} resizeMode="contain" accessibilityIgnoresInvertColors />
		</Tap>
	);
}

const HEADING: Record<number, { readonly size: number; readonly line: number }> = { 1: { size: 21, line: 28 }, 2: { size: 19, line: 26 }, 3: { size: 17, line: 24 }, 4: { size: 16, line: 23 }, 5: { size: 15, line: 22 }, 6: { size: 15, line: 22 } };
const CALLOUT_ICON: Record<MdCallout, Parameters<typeof Icon>[0]['name']> = { note: 'info', tip: 'sparkles', important: 'alertCircle', warning: 'alert', caution: 'xCircle' };

function Caret() {
	const { p } = useTheme();
	return <Text style={{ color: p.fgTertiary }}>{' ▍'}</Text>;
}

const BlockView = memo(function BlockView({ block, open, depth, compact }: { readonly block: MdBlock; readonly open: boolean; readonly depth: number; readonly compact?: boolean }): ReactNode {
	const { p } = useTheme();
	const folder = useChatContext()?.folder;
	const body = compact ? TYPE.small : TYPE.reading;
	const ctx: IInlineContext = { p, size: body.size, ...(folder ? { folder } : {}) };
	switch (block.type) {
		case 'paragraph': {
			const only = open ? undefined : soleImage(block.text);
			if (only) {
				return <MarkdownImage src={only.src} alt={only.alt} />;
			}
			return (
				<Text selectable style={{ color: p.fg, fontSize: body.size, lineHeight: body.line, marginVertical: compact ? 2 : 4 }}>
					{renderInlines(parseInline(block.text, open), ctx)}
					{open ? <Caret /> : null}
				</Text>
			);
		}
		case 'heading': {
			const h = HEADING[block.level] ?? HEADING[4];
			return (
				<Text selectable accessibilityRole="header" style={{ color: p.fg, fontSize: h.size, lineHeight: h.line, fontWeight: block.level <= 2 ? '700' : '600', marginTop: depth ? 10 : block.level <= 2 ? 20 : 14, marginBottom: block.level <= 2 ? 6 : 4, letterSpacing: block.level <= 2 ? -0.3 : -0.2 }}>
					{renderInlines(parseInline(block.text, open), { ...ctx, size: h.size })}
				</Text>
			);
		}
		case 'code':
			return <CodeBlock code={block.code} lang={block.lang} streaming={open && !block.closed} />;
		case 'math':
			return (
				<View style={{ marginVertical: 6, padding: 12, borderRadius: RADIUS.md, backgroundColor: p.fillFaint, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke }}>
					<Text selectable style={{ fontFamily: FONT.mono, fontSize: 13, color: p.fg }}>{block.text}</Text>
				</View>
			);
		case 'hr':
			return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.stroke, marginVertical: 14 }} />;
		case 'html':
			return <Text selectable style={{ color: p.fgSecondary, fontSize: body.size, lineHeight: body.line, marginVertical: 4 }}>{stripHtml(block.text)}</Text>;
		case 'quote':
			return block.callout ? (
				<View style={{ marginVertical: 6, padding: 12, borderRadius: RADIUS.md, backgroundColor: p.fillFaint, borderLeftWidth: 3, borderLeftColor: block.callout === 'warning' || block.callout === 'caution' ? p.warning : block.callout === 'tip' ? p.success : block.callout === 'important' ? p.violet : p.info }}>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
						<Icon name={CALLOUT_ICON[block.callout]} size={14} color={p.fgSecondary} />
						<T variant="footnote" weight="600" color={p.fgSecondary} style={{ textTransform: 'capitalize' }}>{block.callout}</T>
					</View>
					<Blocks blocks={block.blocks} open={open} depth={depth + 1} compact={compact} />
				</View>
			) : (
				<View style={{ marginVertical: 6, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: p.stroke, opacity: 0.92 }}>
					<Blocks blocks={block.blocks} open={open} depth={depth + 1} compact={compact} />
				</View>
			);
		case 'list':
			return (
				<View style={{ marginVertical: 4 }}>
					{block.items.map((item, i) => (
						<View key={item.key} style={{ flexDirection: 'row', marginVertical: block.tight ? 1 : 4 }}>
							<View style={{ width: block.ordered ? 26 : 20, paddingTop: item.checked !== undefined ? (body.line - 16) / 2 : 0 }}>
								{item.checked !== undefined ? (
									<View style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1.5, borderColor: item.checked ? p.success : p.fgQuaternary, backgroundColor: item.checked ? p.success : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
										{item.checked ? <Icon name="check" size={11} color={p.onPrimary} strokeWidth={2.6} /> : null}
									</View>
								) : (
									<Text style={{ color: p.fgTertiary, fontSize: body.size, lineHeight: body.line, fontVariant: ['tabular-nums'] }}>
										{block.ordered ? `${block.start + i}.` : depth % 3 === 0 ? '•' : depth % 3 === 1 ? '◦' : '▪'}
									</Text>
								)}
							</View>
							<View style={{ flex: 1, minWidth: 0 }}>
								<Blocks blocks={item.blocks} open={open && i === block.items.length - 1} depth={depth + 1} compact={compact} tight={block.tight} />
							</View>
						</View>
					))}
				</View>
			);
		case 'table':
			return <TableView header={block.header} rows={block.rows} align={block.align} />;
	}
}, (a, b) => a.block === b.block && a.open === b.open && a.depth === b.depth && a.compact === b.compact);

function Blocks({ blocks, open, depth, compact }: { readonly blocks: readonly MdBlock[]; readonly open: boolean; readonly depth: number; readonly compact?: boolean; readonly tight?: boolean }) {
	return (
		<>
			{blocks.map((block, i) => <BlockView key={block.key} block={block} open={open && i === blocks.length - 1} depth={depth} compact={compact} />)}
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

export const Markdown = memo(function Markdown({ text, docKey, streaming = false, compact }: { readonly text: string; readonly docKey?: string; readonly streaming?: boolean; readonly compact?: boolean }) {
	const doc = useMemo(() => docKey ? markdownFor(docKey, text) : parseMarkdown(text), [docKey, text]);
	return <View><Blocks blocks={doc.blocks} open={streaming} depth={0} compact={compact} /></View>;
});

export function TableView({ header, rows, align }: { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly align?: readonly ('left' | 'center' | 'right' | null)[] }) {
	const { p } = useTheme();
	const widths = useMemo(() => header.map((h, c) => {
		const longest = Math.max(h.length, ...rows.map(r => (r[c] ?? '').length));
		return Math.min(260, Math.max(72, longest * 7.4 + 24));
	}), [header, rows]);
	const cell = (text: string, c: number, head: boolean, r: number) => (
		<View key={c} style={{ width: widths[c], paddingHorizontal: 12, paddingVertical: 9, borderLeftWidth: c ? StyleSheet.hairlineWidth : 0, borderColor: p.stroke, backgroundColor: head ? p.fillFaint : r % 2 ? p.fillFaint : 'transparent' }}>
			<Inline text={text} size={13} style={{ lineHeight: 18, fontWeight: head ? '600' : '400', color: head ? p.fgSecondary : p.fg, textAlign: align?.[c] ?? 'left' }} />
		</View>
	);
	return (
		<View style={{ marginVertical: 8, borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, overflow: 'hidden' }}>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
				<View>
					<View style={{ flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.stroke }}>{header.map((h, c) => cell(h, c, true, 0))}</View>
					{rows.map((row, r) => (
						<View key={r} style={{ flexDirection: 'row', borderBottomWidth: r === rows.length - 1 ? 0 : StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
							{header.map((_, c) => cell(row[c] ?? '', c, false, r + 1))}
						</View>
					))}
				</View>
			</ScrollView>
		</View>
	);
}

const COLLAPSE_LINES = 60;

export const CodeBlock = memo(function CodeBlock({ code, lang, path, streaming }: { readonly code: string; readonly lang?: string; readonly path?: string; readonly streaming?: boolean }) {
	const { p } = useTheme();
	const [copied, setCopied] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const isDiff = !streaming && resolveLanguage(lang) === 'diff' && /^@@ /m.test(code);
	const all = useMemo(() => isDiff ? [] : highlight(code, lang), [code, lang, isDiff]);
	const long = !streaming && all.length > COLLAPSE_LINES;
	const lines = long && !expanded ? all.slice(0, COLLAPSE_LINES - 20) : all;
	return (
		<View style={{ marginVertical: 8, borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, backgroundColor: p.codeBg, overflow: 'hidden' }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', height: 36, paddingLeft: 12, paddingRight: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, gap: 6 }}>
				{path ? <Icon name="file" size={12} color={p.fgTertiary} /> : null}
				<T variant="caption" mono color={p.fgTertiary} style={{ letterSpacing: 0.8, flexShrink: 1 }} numberOfLines={1}>{path ? path.split('/').pop() : languageLabel(lang)}</T>
				{streaming ? <T variant="caption" color={p.info}>writing</T> : null}
				<View style={{ flex: 1 }} />
				<Tap haptics="light" onPress={() => {
					void Clipboard.setStringAsync(code);
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				}} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 10, borderRadius: 8 }} accessibilityLabel="Copy code">
					<Icon name={copied ? 'check' : 'copy'} size={14} color={copied ? p.success : p.fgTertiary} />
					<T variant="footnote" color={p.fgTertiary}>{copied ? 'Copied' : 'Copy'}</T>
				</Tap>
			</View>
			{isDiff ? <InlineDiff diff={code} /> : <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
				<Text selectable style={{ fontFamily: FONT.mono, fontSize: 12.5, lineHeight: 19, color: p.syntax.plain, paddingHorizontal: 14, paddingVertical: 12 }}>
					{lines.map((tokens, i) => (
						<Fragment key={i}>
							{tokens.map((token, j) => token.k === 'plain' ? token.v : <Text key={j} style={{ color: p.syntax[token.k], ...(token.k === 'comment' ? styles.em : {}) }}>{token.v}</Text>)}
							{i < lines.length - 1 ? '\n' : ''}
						</Fragment>
					))}
				</Text>
			</ScrollView>}
			{long ? (
				<Tap haptics="selection" onPress={() => setExpanded(e => !e)} style={{ height: 38, alignItems: 'center', justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
					<T variant="footnote" weight="600" color={p.fgSecondary}>{expanded ? 'Show less' : `Show all ${all.length} lines`}</T>
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
	strong: { fontWeight: '600' },
	em: { fontStyle: 'italic' },
});
