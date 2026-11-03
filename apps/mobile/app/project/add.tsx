/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorMessage, type IFolderListing, selectProjects } from '@volt/client-core';
import { router, Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { expandHome } from '../../src/home/paths';
import { useClient, useCollections, useOptionalClient } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { Button, EmptyState, haptic, Icon, IconButton, T, Tap } from '../../src/ui/core';
import { useHeaderScroll } from '../../src/ui/header';
import { Group, ListItem } from '../../src/ui/list';
import { SearchField } from '../../src/ui/SearchField';

export default function AddProjectScreen() {
	return useOptionalClient() ? <AddProject /> : null;
}

/**
 * Add a project by walking the computer's folders, Finder style: where you are as a path of
 * crumbs, the folders here (repositories marked), tap one to go in, Add for the folder you're in or
 * the + on a row. Folders already added say so. A path can be typed instead, and that's all older
 * Volt servers allow.
 */
function AddProject() {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const projects = selectProjects(useCollections(['projects']));
	const added = useMemo(() => new Set(projects.map(project => project.path)), [projects]);
	const [listing, setListing] = useState<IFolderListing | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState('');
	const [typing, setTyping] = useState(false);
	const [typed, setTyped] = useState('');
	const [adding, setAdding] = useState<string | undefined>();
	// An older Volt can't list folders: the picker offers the usual places and the folders projects live in.
	const [legacy, setLegacy] = useState(false);
	const field = useRef<TextInput>(null);
	const onScroll = useHeaderScroll();
	const crumbs = useRef<ScrollView>(null);

	const open = useCallback((path?: string) => {
		setLoading(true);
		setFilter('');
		client.listFolders(path).then(next => {
			setListing(next);
			setError(undefined);
		}, err => {
			if (/NoMethod|Unknown method/i.test(`${(err as { code?: string })?.code ?? ''} ${errorMessage(err)}`)) {
				setLegacy(true);
				return;
			}
			setError(errorMessage(err));
		}).finally(() => setLoading(false));
	}, [client, listing]);

	useEffect(() => {
		open();
		// Opens at the home folder once; later moves go through `open`.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const add = (path: string) => {
		haptic.medium();
		setAdding(path);
		client.addProject(path).then(project => {
			if (project) {
				haptic.success();
				router.back();
				setTimeout(() => router.push({ pathname: '/project/[id]', params: { id: project.id } }), 320);
			}
		}, err => {
			haptic.error();
			setError(errorMessage(err));
		}).finally(() => setAdding(undefined));
	};

	const parts = useMemo(() => crumbsOf(listing), [listing]);
	const q = filter.trim().toLowerCase();
	const folders = (listing?.folders ?? []).filter(folder => !q || folder.name.toLowerCase().includes(q));
	const here = listing?.path;
	const hereName = here ? (here === listing?.home ? 'Home' : here.split('/').filter(Boolean).pop() ?? '/') : undefined;

	if (legacy) {
		const roots = rootFolders(projects.map(project => project.path));
		const start = (path: string) => {
			haptic.selection();
			setTyped(`${path.replace(/^\/(Users|home)\/[^/]+/, '~')}/`);
			field.current?.focus();
		};
		return (
			<View style={{ flex: 1, backgroundColor: p.canvas }}>
				<Stack.Screen options={{ title: 'Add a project', headerRight: undefined }} />
				<View style={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 8, gap: 10 }}>
					<View style={[styles.field, { backgroundColor: p.fill }]}>
						<Icon name="folder" size={16} color={p.fgTertiary} />
						<TextInput ref={field} value={typed} onChangeText={setTyped} placeholder="~/code/my-app" placeholderTextColor={p.fgQuaternary} autoCapitalize="none" autoCorrect={false} keyboardAppearance={p.scheme} selectionColor={p.accent} returnKeyType="done"
							onSubmitEditing={() => typed.trim() && add(expandHome(typed, projects))} style={[styles.input, { color: p.fg }]} />
					</View>
					<Button label="Add project" icon="folderPlus" variant="primary" disabled={!typed.trim()} busy={!!adding} onPress={() => add(expandHome(typed, projects))} />
					{error ? <T variant="footnote" color={p.danger}>{error}</T> : null}
				</View>
				<Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
					{roots.map(section => (
						<Group key={section.title} title={section.title}>
							{section.folders.map(folder => {
								const isAdded = added.has(folder.path);
								return (
									<ListItem key={folder.path} onPress={() => start(folder.path)} accessibilityLabel={folder.label} style={{ minHeight: 48 }}>
										<View style={styles.glyph}><Icon name={folder.icon} size={19} color={p.fgSecondary} /></View>
										<View style={{ flex: 1, minWidth: 0 }}>
											<T variant="body" numberOfLines={1} style={{ fontSize: 15 }}>{folder.label}</T>
											<T variant="footnote" color={isAdded ? p.success : p.fgTertiary} numberOfLines={1} ellipsizeMode="head">{isAdded ? 'Added' : folder.path.replace(/^\/(Users|home)\/[^/]+/, '~')}</T>
										</View>
										{!isAdded ? <IconButton icon="plus" size={18} label={`Add ${folder.label}`} color={p.fgSecondary} disabled={!!adding} onPress={() => add(folder.path)} /> : null}
									</ListItem>
								);
							})}
						</Group>
					))}
					<T variant="footnote" color={p.fgTertiary} style={{ paddingHorizontal: 16, paddingTop: 18 }}>
						Tap a folder to start its path, then type the rest; + adds it as it is. Update Volt on your computer to browse inside folders from here.
					</T>
				</Animated.ScrollView>
			</View>
		);
	}

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{
				title: 'Add a project',
				headerRight: () => <IconButton icon={typing ? 'folder' : 'pencil'} label={typing ? 'Browse folders' : 'Type a path'} color={p.fg} active={typing} onPress={() => setTyping(t => !t)} />,
			}} />
			{typing ? (
				<Animated.View entering={FadeIn.duration(160)} style={{ paddingHorizontal: 16, paddingTop: 8, gap: 10 }}>
					<View style={[styles.field, { backgroundColor: p.fill }]}>
						<Icon name="folder" size={16} color={p.fgTertiary} />
						<TextInput value={typed} onChangeText={setTyped} autoFocus placeholder="~/code/my-app" placeholderTextColor={p.fgQuaternary} autoCapitalize="none" autoCorrect={false} keyboardAppearance={p.scheme} selectionColor={p.accent} returnKeyType="done"
							onSubmitEditing={() => typed.trim() && add(expandHome(typed, projects))} style={[styles.input, { color: p.fg }]} />
					</View>
					{error && !listing ? <T variant="footnote" color={p.fgTertiary}>This Volt can't list folders yet; type the folder's path.</T> : null}
					<Button label="Add project" icon="folderPlus" variant="primary" disabled={!typed.trim()} busy={!!adding} onPress={() => add(expandHome(typed, projects))} />
				</Animated.View>
			) : (
				<>
					<ScrollView ref={crumbs} horizontal showsHorizontalScrollIndicator={false} onContentSizeChange={() => crumbs.current?.scrollToEnd({ animated: false })}
						style={{ flexGrow: 0 }} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 12, height: 34 }}>
						{parts.map((part, i) => (
							<View key={part.path} style={{ flexDirection: 'row', alignItems: 'center' }}>
								{i ? <Icon name="chevronRight" size={12} color={p.fgQuaternary} /> : null}
								<Tap haptics="selection" onPress={() => part.path !== here && open(part.path)} style={{ paddingHorizontal: 6, height: 30, justifyContent: 'center', borderRadius: 7 }}>
									<T variant="small" weight={i === parts.length - 1 ? '600' : '400'} color={i === parts.length - 1 ? p.fg : p.fgTertiary}>{part.label}</T>
								</Tap>
							</View>
						))}
					</ScrollView>
					<SearchField value={filter} onChange={setFilter} placeholder={hereName ? `Find in ${hereName}` : 'Find a folder'} />
					<Animated.FlatList
						data={folders}
						keyExtractor={folder => folder.path}
						onScroll={onScroll}
						scrollEventThrottle={16}
						keyboardDismissMode="on-drag"
						keyboardShouldPersistTaps="handled"
						contentContainerStyle={{ paddingBottom: 24 }}
						ListHeaderComponent={listing?.parent && !q ? (
							<ListItem onPress={() => open(listing.parent)} accessibilityLabel="Up one folder" style={{ minHeight: 44 }}>
								<View style={styles.glyph}><Icon name="arrowUp" size={17} color={p.fgTertiary} /></View>
								<T variant="body" color={p.fgSecondary} style={{ flex: 1 }}>Up to {listing.parent === listing.home ? 'Home' : listing.parent.split('/').filter(Boolean).pop() ?? '/'}</T>
							</ListItem>
						) : null}
						renderItem={({ item: folder }) => {
							const isAdded = added.has(folder.path);
							return (
								<ListItem onPress={() => open(folder.path)} accessibilityLabel={folder.name} style={{ minHeight: 48 }}>
									<View style={styles.glyph}><Icon name={folder.git ? 'folderGit' : 'folder'} size={19} color={folder.git ? p.fg : p.fgSecondary} /></View>
									<View style={{ flex: 1, minWidth: 0 }}>
										<T variant="body" numberOfLines={1} style={{ fontSize: 15 }}>{folder.name}</T>
										{folder.git || isAdded ? <T variant="footnote" color={isAdded ? p.success : p.fgTertiary}>{isAdded ? 'Added' : 'Git repository'}</T> : null}
									</View>
									{!isAdded ? (
										<IconButton icon="plus" size={18} label={`Add ${folder.name}`} color={p.fgSecondary} disabled={!!adding} onPress={() => add(folder.path)} />
									) : null}
									<Icon name="chevronRight" size={15} color={p.fgQuaternary} />
								</ListItem>
							);
						}}
						ListEmptyComponent={loading ? <View style={{ paddingTop: 40 }}><ActivityIndicator color={p.fgTertiary} /></View>
							: error ? <EmptyState icon="alertCircle" title="Couldn't open this folder" body={error} />
								: <T variant="small" color={p.fgTertiary} align="center" style={{ paddingTop: 32 }}>{q ? `No folders match "${filter.trim()}"` : 'No folders in here.'}</T>}
					/>
					{here ? (
						<View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: Math.max(insets.bottom, 12), borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, backgroundColor: p.canvas }}>
							<Button
								label={added.has(here) ? `${hereName} is already a project` : `Add ${hereName}`}
								icon="folderPlus"
								variant="primary"
								size="lg"
								disabled={added.has(here) || here === listing?.home}
								busy={adding === here}
								onPress={() => add(here)}
							/>
						</View>
					) : null}
				</>
			)}
		</View>
	);
}

interface IRootFolder {
	readonly label: string;
	readonly path: string;
	readonly icon: 'home' | 'folder' | 'folderOpen';
}

/**
 * Folders to start from without asking the computer: the usual places in the home folder (found
 * from the projects' paths), then every folder a project lives in, most used first.
 */
function rootFolders(projectPaths: readonly string[]): { readonly title: string; readonly folders: readonly IRootFolder[] }[] {
	const home = projectPaths.map(path => /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(path)?.[1]).find(Boolean);
	const places: IRootFolder[] = home ? [
		{ label: 'Home', path: home, icon: 'home' },
		...['Desktop', 'Documents', 'Downloads', 'Developer'].map(name => ({ label: name, path: `${home}/${name}`, icon: 'folder' as const })),
	] : [];
	// Keyed without case: macOS paths are case-insensitive, and projects added by hand differ (falcon, FALCON).
	const counts = new Map<string, { path: string; count: number }>();
	for (const path of projectPaths) {
		const parent = path.replace(/\/[^/]+\/?$/, '');
		const key = parent.toLowerCase();
		if (parent && key !== home?.toLowerCase() && !places.some(place => place.path.toLowerCase() === key)) {
			const seen = counts.get(key);
			counts.set(key, { path: seen?.path ?? parent, count: (seen?.count ?? 0) + 1 });
		}
	}
	const parents = [...counts.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).map(({ path }) => ({ label: path.split('/').pop() ?? path, path, icon: 'folderOpen' as const }));
	return [
		...(places.length ? [{ title: 'Places', folders: places }] : []),
		...(parents.length ? [{ title: 'Where your projects are', folders: parents }] : []),
	];
}

/** The path as tappable crumbs, starting at Home when it's inside the home folder. */
function crumbsOf(listing: IFolderListing | undefined): { readonly label: string; readonly path: string }[] {
	if (!listing) {
		return [];
	}
	const { path, home } = listing;
	const inHome = path === home || path.startsWith(`${home}/`);
	const base = inHome ? home : '';
	const rest = (inHome ? path.slice(home.length) : path).split('/').filter(Boolean);
	const out = [{ label: inHome ? 'Home' : '/', path: base || '/' }];
	let at = base;
	for (const part of rest) {
		at = `${at}/${part}`;
		out.push({ label: part, path: at });
	}
	return out;
}

const styles = StyleSheet.create({
	field: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, paddingHorizontal: 12, borderRadius: 11 },
	input: { flex: 1, fontSize: 15 },
	glyph: { width: 22, alignItems: 'center' },
});
