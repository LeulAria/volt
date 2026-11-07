/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, errorMessage, highlight, type HighlightedLine, type IFileContent, languageForPath, shortPath } from '@volt/client-core';
import * as Clipboard from 'expo-clipboard';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, ScrollView, Share, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { type DiffsEvent, DiffsView, type IDiffsView } from '../src/files/DiffsView';
import { type IMonacoView, type MonacoEvent, MonacoView } from '../src/files/MonacoView';
import { PathBar } from '../src/files/PathBar';
import { useClient, useOptionalClient } from '../src/state/client';
import { conversationPrefs, useConversationPrefs } from '../src/state/prefs';
import { FONT, useTheme } from '../src/theme/theme';
import { EmptyState, haptic, IconButton, T, Tap } from '../src/ui/core';
import { showImage } from '../src/ui/ImageViewer';
import { ActionSheet } from '../src/ui/sheets';

const LINE_HEIGHT = 19;
const CHAR_WIDTH = 7.25;
/** Past this the file is shown without colours: highlighting it would stall the phone. */
const HIGHLIGHT_LIMIT = 400_000;

export default function FileScreen() {
	const { path, line } = useLocalSearchParams<{ path: string; line?: string }>();
	const client = useOptionalClient();
	return client && path ? <FileView path={path} line={Number(line) || undefined} /> : null;
}

const CodeLine = memo(function CodeLine({ index, tokens, text, gutter, current, wrap }: { readonly index: number; readonly tokens?: HighlightedLine; readonly text: string; readonly gutter: number; readonly current: boolean; readonly wrap: boolean }) {
	const { p } = useTheme();
	return (
		<View style={[styles.line, current ? { backgroundColor: `${p.info}1F` } : null]}>
			<Text style={[styles.mono, styles.num, { width: gutter, color: current ? p.fg : p.fgQuaternary }]}>{index + 1}</Text>
			<Text selectable numberOfLines={wrap ? undefined : 1} style={[styles.mono, { color: p.syntax.plain, paddingRight: 16 }, wrap ? { flex: 1 } : null]}>
				{tokens?.length ? tokens.map((token, j) => token.k === 'plain' ? token.v : <Text key={j} style={{ color: p.syntax[token.k], ...(token.k === 'comment' ? { fontStyle: 'italic' as const } : {}) }}>{token.v}</Text>) : text || ' '}
			</Text>
		</View>
	);
});

/** Monaco ships in the app and starts in well under a second; past this the built-in viewer shows. */
const MONACO_TIMEOUT = 8_000;
/** Past this after the text arrived without the viewer page drawing, the built-in viewer shows. */
const PAGE_TIMEOUT = 10_000;

/**
 * A file from the computer: text read-only in @pierre/diffs' viewer (DiffsView: opens at once,
 * the `line` marked and centred), Monaco (VS Code's editor) once Edit is tapped, Save writing it
 * back; or the picture. If the viewer or Monaco fails to start, text falls back to a native viewer
 * with line numbers and colours.
 */
function FileView({ path, line }: { readonly path: string; readonly line?: number }) {
	const { p, dark } = useTheme();
	const client = useClient();
	const { width: screen } = useWindowDimensions();
	const [content, setContent] = useState<IFileContent | undefined>();
	const [error, setError] = useState<string | undefined>();
	// One choice for every code view (Settings > Wrap long lines); the header toggle flips it.
	const { codeWrap: wrap } = useConversationPrefs();
	const [menu, setMenu] = useState(false);
	const language = languageForPath(path);
	const viewer = useRef<IDiffsView>(null);
	const [page, setPage] = useState<'loading' | 'shown' | 'failed'>('loading');
	const editor = useRef<IMonacoView>(null);
	// The open viewer and editor follow the setting live, whichever screen changed it.
	useEffect(() => {
		viewer.current?.setWrap(wrap);
		editor.current?.setWrap(wrap);
	}, [wrap]);
	// Monaco mounts on the first Edit and stays (Done makes it read-only again, as before).
	const [editorOpen, setEditorOpen] = useState(false);
	const [monaco, setMonaco] = useState<'loading' | 'ready' | 'failed'>('loading');
	const [editing, setEditing] = useState(false);
	const editingRef = useRef(false);
	editingRef.current = editing;
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	// The version on disk the edits start from: a newer one there makes Save fail instead of overwriting it.
	const mtime = useRef<number | undefined>(undefined);
	useEffect(() => {
		mtime.current = content?.mtime;
	}, [content]);
	useEffect(() => {
		if (!editorOpen || monaco !== 'loading') {
			return;
		}
		const timer = setTimeout(() => setMonaco(state => state === 'loading' ? 'failed' : state), MONACO_TIMEOUT);
		return () => clearTimeout(timer);
	}, [editorOpen, monaco]);
	useEffect(() => {
		if (page !== 'loading' || content?.kind !== 'text') {
			return;
		}
		const timer = setTimeout(() => setPage(state => state === 'loading' ? 'failed' : state), PAGE_TIMEOUT);
		return () => clearTimeout(timer);
	}, [page, content]);
	const onViewerEvent = (event: DiffsEvent) => {
		if (event.type === 'rendered') {
			setPage(state => state === 'loading' ? 'shown' : state);
		} else if (event.type === 'error') {
			setPage(state => state === 'shown' ? state : 'failed');
		}
	};
	const onEditorEvent = (event: MonacoEvent) => {
		if (event.type === 'ready') {
			setMonaco('ready');
			// Opened by Edit: start editable.
			if (editingRef.current) {
				editor.current?.setReadOnly(false);
			}
		} else if (event.type === 'error') {
			setMonaco(state => state === 'ready' ? state : 'failed');
		} else if (event.type === 'dirty') {
			setDirty(event.dirty);
		} else if (event.type === 'text') {
			setSaving(true);
			client.writeFile(path, event.text, { mtime: mtime.current }).then(result => {
				mtime.current = result.mtime;
				editor.current?.markSaved(event.version);
				haptic.success();
			}, err => {
				haptic.error();
				Alert.alert('Couldn\'t save', errorMessage(err));
			}).finally(() => setSaving(false));
		}
	};
	const toggleEditing = () => {
		haptic.selection();
		if (!editorOpen) {
			setEditorOpen(true);
			setEditing(true);
			return;
		}
		editor.current?.setReadOnly(editing);
		setEditing(e => !e);
	};

	useEffect(() => {
		let live = true;
		client.readFile(path).then(result => live && setContent(result), err => live && setError(errorMessage(err)));
		return () => {
			live = false;
		};
	}, [client, path]);

	const text = content?.kind === 'text' ? content.text : '';
	const lines = useMemo(() => text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [], [text]);
	// The built-in viewer: the page, or Monaco once editing, failed to start.
	const native = editorOpen ? monaco === 'failed' : page === 'failed';
	const highlighted = useMemo(() => text && native && text.length <= HIGHLIGHT_LIMIT ? highlight(text, language.fence) : undefined, [text, language.fence, native]);
	const source = useMemo(() => content?.kind === 'text' ? { name: path, text: content.text, ...(line ? { line } : {}) } : undefined, [content, path, line]);
	const gutter = String(Math.max(lines.length, 1)).length * 7.5 + 14;
	const width = useMemo(() => {
		let longest = 0;
		for (const l of lines) {
			longest = Math.max(longest, l.length);
		}
		return Math.max(screen, Math.ceil(Math.min(longest, 1200) * CHAR_WIDTH) + gutter + 32);
	}, [lines, gutter, screen]);

	const title = basename(path);
	const list = content?.kind === 'text' ? (
		<FlatList
			data={lines}
			keyExtractor={(_l, i) => String(i)}
			renderItem={({ item, index }) => <CodeLine index={index} text={item} tokens={highlighted?.[index]} gutter={gutter} current={index + 1 === line} wrap={wrap} />}
			initialNumToRender={60}
			maxToRenderPerBatch={60}
			windowSize={11}
			getItemLayout={wrap ? undefined : (_data, index) => ({ length: LINE_HEIGHT, offset: LINE_HEIGHT * index + 8, index })}
			initialScrollIndex={!wrap && line && line > 8 && line <= lines.length ? line - 6 : undefined}
			contentContainerStyle={{ paddingVertical: 8, paddingBottom: 60 }}
			style={wrap ? { flex: 1 } : { width }}
		/>
	) : null;

	return (
		<View style={{ flex: 1, backgroundColor: p.codeBg }}>
			<Stack.Screen options={{
				title,
				headerRight: () => (
					<View style={{ flexDirection: 'row', alignItems: 'center' }}>
						{monaco === 'ready' && dirty ? (
							<Tap haptics="light" disabled={saving} onPress={() => editor.current?.requestText()} accessibilityRole="button" accessibilityLabel="Save" hitSlop={8}
								style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, justifyContent: 'center', backgroundColor: p.primary, marginRight: 4, opacity: saving ? 0.6 : 1 }}>
								<T variant="small" weight="600" color={p.onPrimary}>{saving ? 'Saving' : 'Save'}</T>
							</Tap>
						) : null}
						{content?.kind === 'text' && !native ? <IconButton icon={editing ? 'check' : 'pencil'} label={editing ? 'Done editing' : 'Edit'} color={editing ? p.accent : p.fg} onPress={toggleEditing} /> : null}
						{content?.kind === 'text' ? <IconButton icon="wrapText" active={wrap} label="Wrap lines" color={wrap ? p.fg : p.fgSecondary} onPress={() => conversationPrefs.set({ codeWrap: !wrap })} /> : null}
						<IconButton icon="more" label="File actions" color={p.fg} onPress={() => setMenu(true)} />
					</View>
				),
			}} />
			<PathBar path={path} right={content?.kind === 'text' ? <T variant="caption" color={p.fgQuaternary}>{lines.length} lines</T> : undefined} />
			{/* The viewer page starts while the file loads (most are text); a picture or a binary replaces it. */}
			{error ? <EmptyState icon="alertCircle" title="Couldn't open the file" body={error} />
				: content?.kind === 'image' ? (
					<Tap onPress={() => showImage(`data:${content.mime};base64,${content.base64}`, title)} style={{ flex: 1, padding: 16 }}>
						<Image source={{ uri: `data:${content.mime};base64,${content.base64}` }} style={{ flex: 1 }} resizeMode="contain" />
					</Tap>
				)
					: content && content.kind !== 'text' ? <EmptyState icon="file" title={content.kind === 'tooLarge' ? 'Too large to show' : 'Not a text file'} body={`${title} is ${Math.round(content.size / 1024)} KB.`} />
						: content && native ? (wrap ? list : <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>{list}</ScrollView>)
							: editorOpen ? (
								<KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
									<MonacoView ref={editor} text={text} language={language.monaco} dark={dark} background={p.codeBg} lineColor={`${p.info}2E`} wrap={wrap} line={line} onEvent={onEditorEvent} />
									{monaco === 'loading' ? <View style={[StyleSheet.absoluteFill, { backgroundColor: p.codeBg, paddingTop: 60 }]}><ActivityIndicator color={p.fgTertiary} /></View> : null}
								</KeyboardAvoidingView>
							)
								: <DiffsView ref={viewer} p={p} mode="file" wrap={wrap} source={source} onEvent={onViewerEvent} />}
			<ActionSheet visible={menu} onClose={() => setMenu(false)} title={title} subtitle={shortPath(path, 48)} actions={[
				{ label: 'Copy path', icon: 'link', onPress: () => {
					void Clipboard.setStringAsync(path);
					haptic.success();
				} },
				...(content?.kind === 'text' ? [
					{ label: 'Copy contents', icon: 'copy' as const, onPress: () => {
						void Clipboard.setStringAsync(text);
						haptic.success();
					} },
					{ label: 'Share', icon: 'send' as const, onPress: () => void Share.share({ title, message: text.length > 100_000 ? text.slice(0, 100_000) : text }).catch(() => undefined) },
				] : []),
				{ label: 'Compare with last commit', icon: 'fileDiff', onPress: () => router.push({ pathname: '/diff', params: { file: path, title: basename(path), mode: 'git' } }) },
			]} />
		</View>
	);
}

const styles = StyleSheet.create({
	mono: { fontFamily: FONT.mono, fontSize: 12.5, lineHeight: LINE_HEIGHT },
	line: { flexDirection: 'row', minHeight: LINE_HEIGHT },
	num: { textAlign: 'right', paddingRight: 12, fontSize: 11 },
});
