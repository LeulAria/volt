/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	highlight, inlineText, type IVoltPalette, markdownFor, type MdBlock, type MdCallout, type MdInline, parseInline, parseMarkdown, RADIUS, resolveLanguage, texToText, type VoltClient
} from '@volt/client-core';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { createContext, Fragment, memo, type ReactNode, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Image, Linking, Platform, ScrollView, StyleSheet, Text, type TextStyle, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { parse as parseSvg, SvgAst } from 'react-native-svg';
import { FileIcon } from '../files/FileIcon';
import { useOptionalClient } from '../state/client';
import { useConversationPrefs } from '../state/prefs';
import { FONT, useTheme } from '../theme/theme';
import { haptic, Icon, T, Tap } from '../ui/core';
import { showImage } from '../ui/ImageViewer';
import { openFile, resolveFileLink, useChatContext } from './context';
import {
	base64ToUtf8, flowItems, type HAlign, hasHtmlBlock, hasImage, type HBlock, type HElement, type HInline, type IHImage, imageBox, imageTarget, type ImageTarget, resolveDocTarget, richInlines,
	soleImageOf, structureHtml, svgFromDataUri, svgSize, tableRows, withReferenceLinks
} from './markdownHtml';
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
 *
 * A document (a README, given its `baseDir`) is set as GitHub sets one: regular weight, lines of
 * a paragraph joined, h1/h2 over a hairline, HTML laid out (centred blocks, badges in a row,
 * pictures from the computer). Chat text only takes the HTML path when it has a tag or a picture.
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

function faceFor(tone: MarkdownTone, p: IVoltPalette, doc = false): IFace {
	switch (tone) {
		case 'thinking': return { size: 13, line: 21, color: p.fgTertiary, weight: '400', after: 16 };
		case 'compact': return { size: 13, line: 20, color: p.fg, weight: '300', after: 6 };
		default: return doc ? { size: 14.5, line: 22, color: p.fg, weight: '400', after: 12 } : { size: 14, line: 22, color: p.fg, weight: '300', after: 8 };
	}
}

/** Space and a rule around a block, valid on a `<Text>` and a `<View>` alike. */
interface IBox {
	readonly marginTop?: number;
	readonly marginBottom?: number;
	readonly paddingBottom?: number;
	readonly borderBottomWidth?: number;
	readonly borderColor?: string;
}

function textOf(face: IFace, align?: HAlign): TextStyle {
	return { color: face.color, fontSize: face.size, lineHeight: face.line, fontWeight: face.weight, ...(align ? { textAlign: align } : {}) };
}

/** A document being shown (a README): relative links and pictures resolve against its folder. */
interface IDocContext {
	readonly baseDir: string;
}

const DocContext = createContext<IDocContext | undefined>(undefined);
/** `align="center"` (or right) of the HTML element around a block, as CSS `text-align` inherits. */
const AlignContext = createContext<HAlign | undefined>(undefined);

/** The folder relative paths resolve against: the document's, else the chat's. */
function useFolder(): { readonly folder?: string; readonly doc: boolean } {
	const doc = useContext(DocContext);
	const chat = useChatContext()?.folder;
	const folder = doc?.baseDir ?? chat;
	return { ...(folder ? { folder } : {}), doc: !!doc };
}

interface IInlineContext {
	readonly p: IVoltPalette;
	readonly size: number;
	/** The chat's folder (or the document's): file paths in replies open in the file viewer. */
	readonly folder?: string;
	/** A document: links resolve against `folder`, code spans are just code. */
	readonly doc?: boolean;
	/** Inside a link: its spans take the link's tap, not their own. */
	readonly inLink?: boolean;
}

/** A path-looking inline code span (`src/app.ts`, `app.ts:12`) that opens the file. */
const CODE_PATH = /^(?:\/|\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+(?::\d+)?$/;

function openFolder(path: string, root: string): void {
	router.push({ pathname: '/files', params: { root, dir: path, name: path.split(/[\\/]/).pop() ?? path } });
}

/** What tapping a link does: the browser for the web, the file viewer (or folder) for a path. */
function linkAction(href: string, folder: string | undefined, doc: boolean): (() => void) | undefined {
	const web = /^(https?:|mailto:|tel:)/i.test(href) ? href : /^www\./i.test(href) ? `https://${href}` : href.startsWith('//') ? `https:${href}` : undefined;
	if (web) {
		return () => void Linking.openURL(web).catch(() => undefined);
	}
	if (doc && folder) {
		const target = resolveDocTarget(href, folder);
		return target ? target.dir ? () => openFolder(target.path, folder) : () => openFile(target.path, target.line) : undefined;
	}
	const file = resolveFileLink(href, folder);
	return file ? () => openFile(file.path, file.line) : undefined;
}

function renderTag(node: Extract<HInline, { t: 'tag' }>, ctx: IInlineContext, k: string): ReactNode {
	const inner = renderInlines(node.c, ctx, `${k}.`);
	switch (node.tag) {
		case 'kbd':
			// A key: mono on the code fill, a thin space either side.
			return <Text key={k} style={{ fontFamily: FONT.mono, fontSize: ctx.size - 2.5, fontWeight: '400', color: ctx.p.fg, backgroundColor: ctx.p.fill }}>{' '}{inner}{' '}</Text>;
		case 'sub':
		case 'sup':
			return <Text key={k} style={{ fontSize: Math.round(ctx.size * 0.72) }}>{inner}</Text>;
		case 'small':
			return <Text key={k} style={{ fontSize: Math.round(ctx.size * 0.86) }}>{inner}</Text>;
		case 'big':
			return <Text key={k} style={{ fontSize: Math.round(ctx.size * 1.15) }}>{inner}</Text>;
		case 'mark':
			return <Text key={k} style={{ backgroundColor: `${ctx.p.warning}40`, color: ctx.p.fg }}>{inner}</Text>;
		case 'u':
		case 'ins':
			return <Text key={k} style={{ textDecorationLine: 'underline' }}>{inner}</Text>;
		case 'abbr':
			return <Text key={k} style={{ textDecorationLine: 'underline', textDecorationStyle: 'dotted' }}>{inner}</Text>;
		default:
			return <Fragment key={k}>{inner}</Fragment>;
	}
}

function renderInlines(nodes: readonly HInline[], ctx: IInlineContext, key = ''): ReactNode[] {
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
				const file = !ctx.doc && !ctx.inLink && CODE_PATH.test(node.v) ? resolveFileLink(node.v, ctx.folder) : undefined;
				// A file that opens on tap: link-blue on a light-blue chip, as in Cursor.
				return (
					<Text
						key={k}
						onPress={file ? () => openFile(file.path, file.line) : undefined}
						suppressHighlighting={!file}
						style={{ fontFamily: FONT.mono, fontSize: ctx.size - 1.5, fontWeight: '400', color: file || ctx.inLink ? ctx.p.link : ctx.p.fg, backgroundColor: file ? `${ctx.p.link}24` : ctx.p.fill }}
					>
						{` ${node.v} `}
					</Text>
				);
			}
			case 'strong':
				return <Text key={k} style={ctx.doc ? styles.strongDoc : styles.strong}>{renderInlines(node.c, ctx, `${k}.`)}</Text>;
			case 'em':
				return <Text key={k} style={styles.em}>{renderInlines(node.c, ctx, `${k}.`)}</Text>;
			case 'del':
				return <Text key={k} style={{ textDecorationLine: 'line-through', color: ctx.p.fgTertiary }}>{renderInlines(node.c, ctx, `${k}.`)}</Text>;
			case 'tag':
				return renderTag(node, ctx, k);
			case 'image': {
				// A picture inside a line of text (a table cell): its name, opened full screen on tap.
				const view = !ctx.inLink && /^(https?:|data:image\/)/i.test(node.src) ? () => showImage(node.src, node.alt) : undefined;
				return <Text key={k} style={{ color: ctx.p.link, fontWeight: '500' }} onPress={view}>{node.alt || 'image'}</Text>;
			}
			case 'link': {
				const onPress = linkAction(node.href, ctx.folder, !!ctx.doc);
				// Links: medium weight in the link colour (a document's at its own weight, as GitHub sets them; its in-page anchors read as links too).
				const linked = !!onPress || (!!ctx.doc && node.href.startsWith('#'));
				return (
					<Text key={k} style={linked ? ctx.doc ? { color: ctx.p.link } : { color: ctx.p.link, fontWeight: '500' } : { textDecorationLine: 'underline', textDecorationColor: ctx.p.fgQuaternary }} onPress={onPress} suppressHighlighting={false}>
						{renderInlines(node.c, { ...ctx, inLink: true }, `${k}.`)}
					</Text>
				);
			}
		}
	});
}

export function Inline({ text, open, style, size = 14 }: { readonly text: string; readonly open?: boolean; readonly style?: TextStyle; readonly size?: number }) {
	const { p } = useTheme();
	const { folder, doc } = useFolder();
	const nodes = richInlines(text, doc, open) ?? parseInline(text, open);
	return <Text style={[{ color: p.fg, fontSize: size }, style]}>{renderInlines(nodes, { p, size, ...(folder ? { folder } : {}), ...(doc ? { doc } : {}) })}</Text>;
}

//#region Images

type SvgTree = NonNullable<ReturnType<typeof parseSvg>>;

type LoadedImage =
	| { readonly kind: 'raster'; readonly uri: string; readonly width: number; readonly height: number }
	| { readonly kind: 'svg'; readonly ast: SvgTree; readonly width: number; readonly height: number; readonly uri?: string }
	| { readonly kind: 'failed' };

const FAILED: LoadedImage = { kind: 'failed' };
const SVG_FILL = { width: '100%', height: '100%' };
const IMAGE_CACHE = 80;
const loadedImages = new Map<string, LoadedImage>();
const loadingImages = new Map<string, Promise<LoadedImage>>();

function targetKey(target: ImageTarget): string {
	return target.kind === 'file' ? `file:${target.path}` : target.uri;
}

function rasterSize(uri: string): Promise<{ readonly width: number; readonly height: number } | undefined> {
	return new Promise(resolve => Image.getSize(uri, (width, height) => resolve(width > 0 && height > 0 ? { width, height } : undefined), () => resolve(undefined)));
}

/** An SVG document parsed once for drawing at any size (a `viewBox` added when it has none, so it scales). */
function svgImage(xml: string, uri?: string): LoadedImage {
	const size = svgSize(xml);
	if (!size) {
		return FAILED;
	}
	try {
		const ast = parseSvg(xml);
		if (!ast) {
			return FAILED;
		}
		if (size.viewBox && !ast.props.viewBox) {
			ast.props.viewBox = size.viewBox;
		}
		return { kind: 'svg', ast, width: size.width, height: size.height, ...(uri ? { uri } : {}) };
	} catch {
		return FAILED;
	}
}

async function fetchSvg(uri: string): Promise<LoadedImage> {
	const response = await fetch(uri);
	const type = response.headers.get('content-type') ?? '';
	if (!response.ok || (type && !/svg|xml|text\/plain|octet-stream/i.test(type))) {
		return FAILED;
	}
	const text = await response.text();
	return /<svg[\s>]/i.test(text) ? svgImage(text, uri) : FAILED;
}

async function loadImage(target: ImageTarget, client: VoltClient | undefined): Promise<LoadedImage> {
	switch (target.kind) {
		case 'remote': {
			// Badges (shields.io and friends) are SVG, which `Image` can't draw: fetch and draw them as vectors.
			if (target.svg) {
				const svg = await fetchSvg(target.uri).catch(() => FAILED);
				if (svg !== FAILED) {
					return svg;
				}
			}
			const size = await rasterSize(target.uri);
			if (size) {
				return { kind: 'raster', uri: target.uri, ...size };
			}
			return target.svg ? FAILED : fetchSvg(target.uri).catch(() => FAILED);
		}
		case 'data': {
			if (target.svg) {
				const xml = svgFromDataUri(target.uri);
				return xml ? svgImage(xml) : FAILED;
			}
			const size = await rasterSize(target.uri);
			return size ? { kind: 'raster', uri: target.uri, ...size } : FAILED;
		}
		case 'file': {
			// A picture beside the document, read from the computer.
			const file = client ? await client.readFile(target.path).catch(() => undefined) : undefined;
			if (file?.kind === 'image') {
				if (/svg/i.test(file.mime)) {
					return svgImage(base64ToUtf8(file.base64));
				}
				const uri = `data:${file.mime};base64,${file.base64}`;
				const size = await rasterSize(uri);
				return size ? { kind: 'raster', uri, ...size } : FAILED;
			}
			return file?.kind === 'text' && target.svg ? svgImage(file.text) : FAILED;
		}
	}
}

function remember(key: string, value: LoadedImage): void {
	loadedImages.delete(key);
	loadedImages.set(key, value);
	if (loadedImages.size > IMAGE_CACHE) {
		const oldest = loadedImages.keys().next().value;
		if (oldest !== undefined) {
			loadedImages.delete(oldest);
		}
	}
}

/** The picture behind `target`, loaded once per address and kept for the next time it's drawn. */
function useLoadedImage(target: ImageTarget | undefined, client: VoltClient | undefined): LoadedImage | undefined {
	const key = target ? targetKey(target) : undefined;
	const [state, setState] = useState<{ readonly key: string; readonly value: LoadedImage } | undefined>(() => {
		const hit = key ? loadedImages.get(key) : undefined;
		return key && hit ? { key, value: hit } : undefined;
	});
	useEffect(() => {
		if (!target || !key) {
			return;
		}
		const hit = loadedImages.get(key);
		if (hit) {
			setState(s => s?.key === key && s.value === hit ? s : { key, value: hit });
			return;
		}
		// Not connected yet: wait for the machine rather than remember a failure.
		if (target.kind === 'file' && !client) {
			return;
		}
		let live = true;
		let job = loadingImages.get(key);
		if (!job) {
			job = loadImage(target, client).catch(() => FAILED);
			loadingImages.set(key, job);
			void job.then(value => {
				loadingImages.delete(key);
				remember(key, value);
			});
		}
		void job.then(value => {
			if (live) {
				setState({ key, value });
			}
		});
		return () => {
			live = false;
		};
		// `target` is derived from `key`.
	}, [key, client]);
	return key && state?.key === key ? state.value : undefined;
}

/**
 * A picture in Markdown or HTML (`![alt](src)`, `<img src width height>`, `<picture>`): from the
 * web, a `data:` URI or the computer (a path beside the document), SVG drawn as vectors. Sized as
 * a browser sizes it, never wider than the column, slightly rounded. Tap opens its link, or the
 * picture full screen. `card`: a picture on its own in a chat reply, drawn as the reply's card.
 */
const RichImage = memo(function RichImage({ image, href, card }: { readonly image: IHImage; readonly href?: string; readonly card?: boolean }) {
	const { p, dark } = useTheme();
	const { folder, doc } = useFolder();
	const client = useOptionalClient();
	const { width: screen } = useWindowDimensions();
	const src = (dark ? image.dark : image.light) ?? image.src;
	const target = useMemo(() => imageTarget(src, folder, doc), [src, folder, doc]);
	const loaded = useLoadedImage(target, client);
	const label = image.alt || 'Image';
	const open = href ? linkAction(href, folder, doc) : undefined;
	const remote = loaded?.kind === 'svg' ? loaded.uri : undefined;
	const onPress = open ?? (loaded?.kind === 'raster' ? () => showImage(loaded.uri, image.alt) : remote ? () => void Linking.openURL(remote).catch(() => undefined) : undefined);
	const drawn = loaded?.kind === 'raster'
		? <Image source={{ uri: loaded.uri }} style={styles.fill} resizeMode="contain" accessibilityIgnoresInvertColors />
		: loaded?.kind === 'svg' ? <SvgAst ast={loaded.ast} override={SVG_FILL} /> : null;

	if (!target || loaded?.kind === 'failed') {
		const name = src.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
		const tap = open ?? (/^https?:/i.test(src) ? () => void Linking.openURL(src).catch(() => undefined) : undefined);
		if (card) {
			// A picture that didn't load: what it was, and its address to open elsewhere.
			return (
				<Tap haptics="light" onPress={tap} accessibilityLabel={`${label} (not loaded)`} style={{ marginVertical: 6, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: RADIUS.md, backgroundColor: p.fillFaint, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, maxWidth: '100%' }}>
					<Icon name="image" size={16} color={p.fgTertiary} />
					<View style={{ flexShrink: 1 }}>
						<T variant="small" numberOfLines={1}>{label}</T>
						<T variant="caption" color={p.fgTertiary} numberOfLines={1}>{name}</T>
					</View>
				</Tap>
			);
		}
		// As a browser shows a broken picture: its alt text (or file name) in a small frame.
		const chip = (
			<>
				<Icon name="image" size={13} color={p.fgTertiary} />
				<T variant="caption" color={open ? p.link : p.fgTertiary} numberOfLines={1} style={{ flexShrink: 1 }}>{image.alt || name.split('/').pop() || 'Image'}</T>
			</>
		);
		const chipStyle: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, backgroundColor: p.fillFaint, maxWidth: '100%' };
		return tap ? <Tap haptics="light" onPress={tap} accessibilityLabel={`${label} (not loaded)`} style={chipStyle}>{chip}</Tap> : <View accessibilityLabel={`${label} (not loaded)`} style={chipStyle}>{chip}</View>;
	}

	if (card) {
		const width = Math.min(screen - 56, 520);
		const ratio = loaded ? loaded.width / loaded.height : undefined;
		return (
			<Tap haptics="light" onPress={onPress} accessibilityLabel={label} style={{ marginVertical: 8, alignSelf: 'flex-start', borderRadius: 8, overflow: 'hidden', backgroundColor: p.fill, borderWidth: 1, borderColor: p.strokeFaint }}>
				<View style={{ width, height: ratio ? Math.min(width / ratio, 480) : 180 }}>{drawn}</View>
			</Tap>
		);
	}

	const box = imageBox(image.width, image.height, loaded) ?? (target.svg ? { width: 88, aspectRatio: 88 / 20 } : { width: '100%' as const, aspectRatio: 16 / 9 });
	// Vector art (badges) brings its own corners; photos and screenshots get a slight rounding.
	const style: ViewStyle = { width: box.width, maxWidth: '100%', aspectRatio: box.aspectRatio, borderRadius: loaded?.kind === 'svg' ? 0 : 6, overflow: 'hidden', ...(loaded ? {} : { backgroundColor: p.fillFaint }) };
	return onPress ? (
		<Tap haptics="light" onPress={onPress} accessibilityRole={open ? 'link' : 'imagebutton'} accessibilityLabel={label} style={style}>{drawn}</Tap>
	) : (
		<View accessibilityRole="image" accessibilityLabel={label} style={style}>{drawn}</View>
	);
});

//#endregion

/**
 * Inline content that may hold pictures: one `<Text>` when it's only text, else a row that wraps
 * like a line of text (badges side by side, a logo beside a title). A run of nothing but `<br>`s
 * is that many blank lines.
 */
function FlowView({ nodes, ctx, face, style }: { readonly nodes: readonly HInline[]; readonly ctx: IInlineContext; readonly face: IFace; readonly style?: IBox }) {
	const align = useContext(AlignContext);
	const items = useMemo(() => flowItems(nodes), [nodes]);
	const text = textOf(face, align);
	if (nodes.every(node => node.t === 'br')) {
		return <View style={[{ height: nodes.length * face.line }, style]} />;
	}
	if (!items) {
		return <Text selectable style={[text, style]}>{renderInlines(nodes, ctx)}</Text>;
	}
	return (
		<View style={[{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 4, justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start' }, style]}>
			{items.map((item, i) => {
				switch (item.k) {
					case 'image':
						return <RichImage key={i} image={item.image} {...(item.href ? { href: item.href } : {})} />;
					case 'break':
						return <View key={i} style={{ width: '100%', height: item.empty ? face.line : 0 }} />;
					case 'space':
						return <View key={i} style={{ width: Math.round(face.size * 0.3) }} />;
					case 'text':
						return <Text key={i} selectable style={[text, { flexShrink: 1, maxWidth: '100%' }]}>{renderInlines(item.nodes, ctx)}</Text>;
				}
			})}
		</View>
	);
}

/** Headings: a step above the 14px body, not a display size (agentMarkdown.css). */
const HEADING: Record<number, { readonly size: number; readonly line: number }> = { 1: { size: 18, line: 26 }, 2: { size: 16.5, line: 24 }, 3: { size: 15.5, line: 22 }, 4: { size: 15, line: 22 }, 5: { size: 14, line: 22 }, 6: { size: 14, line: 22 } };
/** A document's headings, GitHub's scale (2em, 1.5em, 1.25em, 1em, .875em, .85em) brought to the phone. */
const DOC_HEADING: Record<number, { readonly size: number; readonly line: number }> = { 1: { size: 25, line: 32 }, 2: { size: 20.5, line: 27 }, 3: { size: 17.5, line: 24 }, 4: { size: 15, line: 22 }, 5: { size: 14, line: 20 }, 6: { size: 13, line: 20 } };
const CALLOUT_ICON: Record<MdCallout, Parameters<typeof Icon>[0]['name']> = { note: 'info', tip: 'sparkles', important: 'alertCircle', warning: 'alert', caution: 'xCircle' };
/** Bullets by depth: disc, circle, square. */
const BULLETS = ['•', '◦', '▪'];

function headingFace(level: number, tone: MarkdownTone, p: IVoltPalette, doc: boolean, body: IFace): IFace {
	if (doc && tone === 'reply') {
		const h = DOC_HEADING[level] ?? DOC_HEADING[4];
		return { size: h.size, line: h.line, color: level === 6 ? p.fgTertiary : p.fg, weight: '600', after: 0 };
	}
	const h = tone === 'reply' ? HEADING[level] ?? HEADING[4] : { size: body.size, line: body.line };
	return { size: h.size, line: h.line, color: tone === 'thinking' ? body.color : p.fg, weight: '500', after: 0 };
}

/** Space around a heading; a document's h1 and h2 sit over a hairline, as on GitHub. */
function headingBox(level: number, tone: MarkdownTone, p: IVoltPalette, doc: boolean, top: (n: number) => number, bottom: (n: number) => number): IBox {
	if (doc && tone === 'reply') {
		return level <= 2
			? { marginTop: top(18), marginBottom: bottom(12), paddingBottom: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.stroke }
			: { marginTop: top(14), marginBottom: bottom(8) };
	}
	return { marginTop: top(tone === 'reply' ? 22 : 10), marginBottom: bottom(4) };
}

const BlockView = memo(function BlockView({ block, open, depth, tone, first, last }: { readonly block: MdBlock; readonly open: boolean; readonly depth: number; readonly tone: MarkdownTone; readonly first: boolean; readonly last: boolean }): ReactNode {
	const { p } = useTheme();
	const { folder, doc } = useFolder();
	const align = useContext(AlignContext);
	const face = faceFor(tone, p, doc);
	const ctx: IInlineContext = { p, size: face.size, ...(folder ? { folder } : {}), ...(doc ? { doc } : {}) };
	const top = (n: number) => first ? 0 : n;
	const bottom = (n: number) => last ? 0 : n;
	switch (block.type) {
		case 'paragraph': {
			const style: IBox = { marginTop: top(depth || doc ? 0 : 4), marginBottom: bottom(depth ? 0 : face.after) };
			// HTML or pictures: laid out as GitHub would. Anything else is the plain (streaming-tinted) paragraph.
			const rich = richInlines(block.text, doc, open);
			if (rich) {
				const only = doc ? undefined : soleImageOf(rich);
				if (only) {
					return <RichImage image={only} card />;
				}
				return <FlowView nodes={rich} ctx={ctx} face={face} style={style} />;
			}
			return <Paragraph text={block.text} open={open && tone === 'reply'} ctx={ctx} face={face} style={style} />;
		}
		case 'heading': {
			const h = headingFace(block.level, tone, p, doc, face);
			const box = headingBox(block.level, tone, p, doc, top, bottom);
			const hctx = { ...ctx, size: h.size };
			const rich = richInlines(block.text, doc, open);
			if (rich && hasImage(rich)) {
				return <View accessibilityRole="header" style={box}><FlowView nodes={rich} ctx={hctx} face={h} /></View>;
			}
			const title = <Text selectable accessibilityRole="header" style={[textOf(h, align), doc ? null : box]}>{renderInlines(rich ?? parseInline(block.text, open), hctx)}</Text>;
			return doc ? <View style={box}>{title}</View> : title;
		}
		case 'code':
			return <View style={{ marginTop: top(doc ? 2 : 12), marginBottom: bottom(12) }}><CodeBlock code={block.code} lang={block.lang} streaming={open && !block.closed} /></View>;
		case 'math':
			return open ? (
				<View style={{ marginVertical: 6, padding: 12, borderRadius: RADIUS.md, backgroundColor: p.fillFaint }}>
					<Text selectable style={{ fontFamily: FONT.mono, fontSize: 13, color: p.fgTertiary }}>{block.text}</Text>
				</View>
			) : <MathBlock tex={block.text} />;
		case 'hr':
			return <View style={{ height: doc ? 2 : 1, borderRadius: 1, backgroundColor: p.stroke, marginTop: top(doc ? 10 : 16), marginBottom: bottom(doc ? 22 : 16) }} />;
		case 'html':
			return <HtmlBlocks nodes={structureHtml([block], doc)} depth={depth} tone={tone} first={first} last={last} />;
		case 'quote':
			return block.callout ? (
				<View style={{ marginTop: top(doc ? 2 : 8), marginBottom: bottom(doc ? 12 : 8), paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: p.fillFaint, borderWidth: 1, borderColor: p.strokeFaint }}>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
						<Icon name={CALLOUT_ICON[block.callout]} size={13} color={block.callout === 'warning' || block.callout === 'caution' ? p.warning : block.callout === 'tip' ? p.success : p.info} />
						<Text style={{ fontSize: 13, lineHeight: 20, fontWeight: '500', color: p.fgSecondary, textTransform: 'capitalize' }}>{block.callout}</Text>
					</View>
					<Blocks blocks={block.blocks} open={open} depth={depth + 1} tone={tone} />
				</View>
			) : (
				// A blockquote: 16px in, a 3px rounded bar in the stroke colour, secondary text.
				<View style={{ marginTop: top(doc ? 2 : 8), marginBottom: bottom(doc ? 12 : 8), paddingVertical: 2, paddingLeft: 16 }}>
					<View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, borderRadius: 2, backgroundColor: p.stroke }} />
					<View style={{ opacity: 0.86 }}><Blocks blocks={block.blocks} open={open} depth={depth + 1} tone={tone} /></View>
				</View>
			);
		case 'list':
			return (
				<View style={{ marginTop: top(doc ? (depth ? 4 : 0) : 8), marginBottom: bottom(depth ? 0 : doc ? 12 : 18), gap: doc ? 5 : 8 }}>
					{block.items.map((item, i) => (
						<View key={item.key} style={{ flexDirection: 'row' }}>
							<View style={{ width: item.checked !== undefined ? 22 : doc && !block.ordered ? 22 : 30, alignItems: item.checked !== undefined ? 'flex-start' : 'flex-end', paddingRight: item.checked !== undefined ? 0 : 8 }}>
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
			return <View style={{ marginTop: top(doc ? 2 : 8), marginBottom: bottom(12) }}><TableView header={block.header} rows={block.rows} align={block.align} /></View>;
	}
}, (a, b) => a.block === b.block && a.open === b.open && a.depth === b.depth && a.tone === b.tone && a.first === b.first && a.last === b.last);

interface IHtmlProps {
	/** The block being streamed (the reply's last), if any. */
	readonly openKey?: string;
	readonly depth: number;
	readonly tone: MarkdownTone;
	readonly first: boolean;
	readonly last: boolean;
	/** The text style inline runs take (a heading's, a table header's); the body's when unset. */
	readonly face?: IFace;
}

/** Blocks with HTML among them, as {@link structureHtml} nests them. */
function HtmlBlocks({ nodes, ...props }: { readonly nodes: readonly HBlock[] } & IHtmlProps) {
	return (
		<>
			{nodes.map((node, i) => <HtmlNode key={node.key} node={node} {...props} first={props.first && i === 0} last={props.last && i === nodes.length - 1} />)}
		</>
	);
}

function HtmlNode({ node, ...props }: { readonly node: HBlock } & IHtmlProps): ReactNode {
	const { p } = useTheme();
	const { folder, doc } = useFolder();
	switch (node.k) {
		case 'md':
			return <BlockView block={node.block} open={node.block.key === props.openKey} depth={props.depth} tone={props.tone} first={props.first} last={props.last} />;
		case 'flow': {
			const face = props.face ?? faceFor(props.tone, p, doc);
			return <FlowView nodes={node.nodes} ctx={{ p, size: face.size, ...(folder ? { folder } : {}), ...(doc ? { doc } : {}) }} face={face} />;
		}
		case 'el':
			return <HtmlElement el={node} {...props} />;
	}
}

/** An HTML element: GitHub's look for each (`<p>` a paragraph, `<h1>` a heading, `<details>` folds...); anything else a plain box. */
function HtmlElement({ el, ...props }: { readonly el: HElement } & IHtmlProps): ReactNode {
	const { p } = useTheme();
	const { doc } = useFolder();
	const inherited = useContext(AlignContext);
	const base = props.face ?? faceFor(props.tone, p, doc);
	const top = (n: number) => props.first ? 0 : n;
	const bottom = (n: number) => props.last ? 0 : n;
	const inner = (children: readonly HBlock[], overrides: Partial<IHtmlProps> = {}) => <HtmlBlocks nodes={children} {...props} {...overrides} />;
	let body: ReactNode;
	switch (el.tag) {
		case 'hr':
			return <View style={{ height: doc ? 2 : 1, borderRadius: 1, backgroundColor: p.stroke, marginTop: top(10), marginBottom: bottom(doc ? 22 : 16) }} />;
		case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
			const level = Number(el.tag[1]);
			body = <View accessibilityRole="header" style={headingBox(level, props.tone, p, doc, top, bottom)}>{inner(el.children, { face: headingFace(level, props.tone, p, doc, base), first: true, last: true })}</View>;
			break;
		}
		case 'p':
			body = <View style={{ marginBottom: bottom(base.after) }}>{inner(el.children, { first: true, last: true })}</View>;
			break;
		case 'details':
			body = <DetailsView el={el} props={props} face={base} style={{ marginTop: top(2), marginBottom: bottom(base.after) }} />;
			break;
		case 'summary':
		case 'dt':
			body = inner(el.children, { face: { ...base, weight: '600' } });
			break;
		case 'dd':
			body = <View style={{ paddingLeft: 16, marginBottom: bottom(6) }}>{inner(el.children, { first: true, last: true })}</View>;
			break;
		case 'figcaption':
			body = inner(el.children, { face: { ...base, size: base.size - 1.5, line: base.line - 3, color: p.fgTertiary } });
			break;
		case 'blockquote':
			body = (
				<View style={{ marginTop: top(2), marginBottom: bottom(base.after), paddingVertical: 2, paddingLeft: 16 }}>
					<View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, borderRadius: 2, backgroundColor: p.stroke }} />
					<View style={{ opacity: 0.86 }}>{inner(el.children, { first: true, last: true, depth: props.depth + 1 })}</View>
				</View>
			);
			break;
		case 'ul':
		case 'ol': {
			const items = el.children.filter((child): child is HElement => child.k === 'el' && child.tag === 'li');
			const start = Number(el.attrs.start) || 1;
			body = (
				<View style={{ marginTop: top(2), marginBottom: bottom(base.after), gap: 5 }}>
					{items.map((li, i) => (
						<View key={li.key} style={{ flexDirection: 'row' }}>
							<View style={{ width: el.tag === 'ol' ? 30 : 22, alignItems: 'flex-end', paddingRight: 8 }}>
								<Text style={{ color: el.tag === 'ol' ? base.color : p.fgTertiary, fontSize: base.size, lineHeight: base.line, fontWeight: base.weight, fontVariant: ['tabular-nums'] }}>{el.tag === 'ol' ? `${start + i}.` : BULLETS[props.depth % 3]}</Text>
							</View>
							<View style={{ flex: 1, minWidth: 0 }}>{inner(li.children, { first: true, last: true, depth: props.depth + 1 })}</View>
						</View>
					))}
				</View>
			);
			break;
		}
		case 'table':
			body = <HtmlTable el={el} props={props} face={base} style={{ marginTop: top(2), marginBottom: bottom(base.after) }} />;
			break;
		default:
			body = <View>{inner(el.children)}</View>;
	}
	return el.align && el.align !== inherited ? <AlignContext.Provider value={el.align}>{body}</AlignContext.Provider> : body;
}

/** `<details>`: its `<summary>` with a chevron, the rest shown on tap (open to start with `open`). */
function DetailsView({ el, props, face, style }: { readonly el: HElement; readonly props: IHtmlProps; readonly face: IFace; readonly style: ViewStyle }) {
	const { p } = useTheme();
	const summary = el.children.find((child): child is HElement => child.k === 'el' && child.tag === 'summary');
	const body = el.children.filter(child => child !== summary);
	const [open, setOpen] = useState('open' in el.attrs);
	const strong: IFace = { ...face, weight: '600' };
	return (
		<View style={style}>
			<Tap haptics="selection" onPress={() => setOpen(o => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
				<View style={{ height: face.line, justifyContent: 'center' }}>
					<Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} color={p.fgTertiary} />
				</View>
				<View style={{ flex: 1, minWidth: 0 }}>
					{summary ? <HtmlBlocks nodes={summary.children} {...props} face={strong} first last /> : <Text style={textOf(strong)}>Details</Text>}
				</View>
			</Tap>
			{open && body.length ? (
				<View style={{ paddingLeft: 20, paddingTop: 8 }}>
					<HtmlBlocks nodes={body} {...props} first last />
				</View>
			) : null}
		</View>
	);
}

/** An HTML `<table>`: rows of equal-share cells (`colspan` widens one), headers on the faint fill. */
function HtmlTable({ el, props, face, style }: { readonly el: HElement; readonly props: IHtmlProps; readonly face: IFace; readonly style: ViewStyle }) {
	const { p } = useTheme();
	const rows = useMemo(() => tableRows(el), [el]);
	return (
		<View style={[{ borderRadius: 8, borderWidth: 1, borderColor: p.stroke, overflow: 'hidden', backgroundColor: p.card }, style]}>
			{rows.map((row, r) => (
				<View key={row.key} style={{ flexDirection: 'row', borderTopWidth: r ? 1 : 0, borderColor: p.strokeFaint }}>
					{row.cells.map((cell, c) => {
						const head = cell.tag === 'th';
						const content = <HtmlBlocks nodes={cell.children} {...props} face={{ ...face, size: 13, line: 20, weight: head ? '600' : face.weight }} first last />;
						return (
							<View key={cell.key} style={{ flex: Number(cell.attrs.colspan) || 1, minWidth: 0, paddingHorizontal: 10, paddingVertical: 8, borderLeftWidth: c ? 1 : 0, borderColor: p.strokeFaint, ...(head ? { backgroundColor: p.fillFaint } : {}) }}>
								{cell.align ? <AlignContext.Provider value={cell.align}>{content}</AlignContext.Provider> : content}
							</View>
						);
					})}
				</View>
			))}
		</View>
	);
}

/** How long streamed text keeps its fresh tint before it settles to the text colour. */
const FRESH_MS = 520;

/**
 * Streamed reply text arrives light blue and settles to the text colour (agentFreshText.ts): the
 * characters added since the last frame are tinted until the next one, or for a moment once the
 * stream pauses. Only plain text at the paragraph's end is tinted, so inline markup still parses.
 */
function Paragraph({ text, open, ctx, face, style }: { readonly text: string; readonly open: boolean; readonly ctx: IInlineContext; readonly face: IFace; readonly style: TextStyle }) {
	const { dark } = useTheme();
	const align = useContext(AlignContext);
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
		<Text selectable style={[textOf(face, align), style]}>
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
	// HTML blocks open and close elements around the blocks between them; without any, blocks render as they are.
	const doc = !!useContext(DocContext);
	const html = useMemo(() => hasHtmlBlock(blocks, doc) ? structureHtml(blocks, doc) : undefined, [blocks, doc]);
	if (html) {
		const openKey = open ? blocks[blocks.length - 1]?.key : undefined;
		return <HtmlBlocks nodes={html} {...(openKey ? { openKey } : {})} depth={depth} tone={tone} first last />;
	}
	return (
		<>
			{blocks.map((block, i) => <BlockView key={block.key} block={block} open={open && i === blocks.length - 1} depth={depth} tone={tone} first={i === 0} last={i === blocks.length - 1} />)}
		</>
	);
}

/**
 * Markdown text. `docKey` caches the parse where it lives (a streamed reply re-parses only its
 * tail). `baseDir`: the folder of the file this text is (a README's folder, an absolute path on
 * the computer); it makes this a document: relative links and pictures resolve against it and
 * open or load through the paired computer, and it is set as GitHub sets a README.
 */
export const Markdown = memo(function Markdown({ text, docKey, streaming = false, compact, tone, baseDir }: { readonly text: string; readonly docKey?: string; readonly streaming?: boolean; readonly compact?: boolean; readonly tone?: MarkdownTone; readonly baseDir?: string }) {
	const source = useMemo(() => withReferenceLinks(text), [text]);
	const doc = useMemo(() => docKey ? markdownFor(docKey, source) : parseMarkdown(source), [docKey, source]);
	const docContext = useMemo(() => baseDir ? { baseDir } : undefined, [baseDir]);
	const body = <View><Blocks blocks={doc.blocks} open={streaming} depth={0} tone={tone ?? (compact ? 'compact' : 'reply')} /></View>;
	return docContext ? <DocContext.Provider value={docContext}>{body}</DocContext.Provider> : body;
});

/** A cell's width in characters as shown (a link's text, not its address). */
function shownLength(text: string): number {
	return /[[\]`*_<]/.test(text) ? inlineText(parseInline(text)).length : text.length;
}

export function TableView({ header, rows, align }: { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly align?: readonly ('left' | 'center' | 'right' | null)[] }) {
	const { p } = useTheme();
	const doc = !!useContext(DocContext);
	// `| | |` over a table: GitHub draws no header row for it.
	const headed = header.some(h => h.trim());
	const widths = useMemo(() => header.map((h, c) => {
		const longest = Math.max(headed ? shownLength(h) : 0, ...rows.map(r => shownLength(r[c] ?? '')));
		return Math.min(260, Math.max(72, longest * 7 + 24));
	}), [header, rows, headed]);
	const cell = (text: string, c: number, head: boolean) => (
		<View key={c} style={{ width: widths[c], paddingHorizontal: 12, paddingVertical: 8, borderLeftWidth: c ? 1 : 0, borderColor: p.strokeFaint }}>
			<Inline text={text} size={13} style={{ lineHeight: 20, fontWeight: head ? doc ? '600' : '500' : doc ? '400' : '300', color: head && !doc ? p.fgSecondary : p.fg, textAlign: align?.[c] ?? 'left' }} />
		</View>
	);
	return (
		<View style={{ borderRadius: 8, borderWidth: 1, borderColor: p.stroke, overflow: 'hidden', backgroundColor: p.card }}>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
				<View>
					{headed ? <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: p.stroke, backgroundColor: p.fillFaint }}>{header.map((h, c) => cell(h, c, true))}</View> : null}
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
	strongDoc: { fontWeight: '600' },
	em: { fontStyle: 'italic' },
	fill: { width: '100%', height: '100%' },
});
