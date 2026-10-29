/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import { type AccessMode, type ComposerMode, errorMessage, type IPromptAttachment, runSelectionProblem, selectProjects, shortPath, startRunGroup } from '@volt/client-core';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer, type IComposerSendExtra } from '../src/chat/Composer';
import { expandHome } from '../src/home/paths';
import { useChatItems, useClient, useCollections, useOptionalClient, useRuntime } from '../src/state/client';
import { useTheme } from '../src/theme/theme';
import { haptic, Icon, IconButton, Pill, StatusIcon, T, Tap } from '../src/ui/core';
import { ActionSheet, InputSheet, type ISheetAction } from '../src/ui/sheets';

const LAST_PROJECT_KEY = 'volt.lastProject';

const SUGGESTIONS = [
	{ icon: 'search' as const, text: 'Explain how this project is structured' },
	{ icon: 'alertCircle' as const, text: 'Find and fix the failing tests' },
	{ icon: 'sparkles' as const, text: 'Review my uncommitted changes' },
	{ icon: 'listChecks' as const, text: 'Plan the next feature with me' },
];

export default function NewChatScreen() {
	const client = useOptionalClient();
	return client ? <NewChat /> : null;
}

function NewChat() {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const runtime = useRuntime();
	const items = useChatItems();
	const cols = useCollections(['projects', 'history']);
	const projects = useMemo(() => selectProjects(cols), [cols]);
	const params = useLocalSearchParams<{ project?: string }>();
	const [projectId, setProjectId] = useState<string | undefined>(params.project);
	const [mode, setMode] = useState<ComposerMode>('Agent');
	const [modelRef, setModelRef] = useState<string | undefined>();
	const [modelTouched, setModelTouched] = useState(false);
	const [multi, setMulti] = useState<readonly string[] | undefined>();
	const [starting, setStarting] = useState(false);
	const [access, setAccess] = useState<AccessMode | undefined>();
	const [picking, setPicking] = useState(false);
	const [adding, setAdding] = useState(false);

	useEffect(() => {
		void AsyncStorage.getItem(LAST_PROJECT_KEY).then(id => {
			if (id) {
				setProjectId(current => current ?? id);
			}
		});
	}, []);
	useEffect(() => {
		if (projects.length && (!projectId || !projects.some(pr => pr.id === projectId))) {
			setProjectId(projects[0].id);
		}
	}, [projects, projectId]);

	const project = projects.find(pr => pr.id === projectId);
	const effectiveModel = modelTouched ? modelRef : runtime.activeCatalogRef;
	const recent = items.filter(item => !item.archived && item.projectId === projectId).slice(0, 4);

	const start = (text: string, attachments: readonly IPromptAttachment[] = [], extra?: IComposerSendExtra) => {
		if (!projectId) {
			setAdding(true);
			return false;
		}
		void AsyncStorage.setItem(LAST_PROJECT_KEY, projectId);
		if (multi) {
			return compare(projectId, text, attachments, extra);
		}
		const id = client.startChat({ projectId, text, mode, ...(effectiveModel ? { modelRef: effectiveModel } : {}), ...(access ? { accessMode: access } : {}), ...(attachments.length ? { attachments } : {}), ...(extra?.mentions.length ? { mentions: extra.mentions } : {}), ...(extra?.displayText && extra.displayText !== text ? { displayText: extra.displayText } : {}) });
		haptic.success();
		router.dismiss();
		router.push({ pathname: '/chat/[id]', params: { id } });
		return true;
	};

	/** One prompt on every ticked model: a chat, branch and worktree each, then the comparison opens. */
	const compare = (project: string, text: string, attachments: readonly IPromptAttachment[], extra?: IComposerSendExtra) => {
		const problem = runSelectionProblem(multi ?? []);
		if (problem || starting) {
			if (problem) {
				client.toast('info', problem);
			}
			return false;
		}
		setStarting(true);
		void startRunGroup(client, {
			projectId: project, text, mode, models: multi!,
			...(access ? { accessMode: access } : {}),
			...(attachments.length ? { attachments } : {}),
			...(extra?.mentions.length ? { mentions: extra.mentions } : {}),
			...(extra?.displayText && extra.displayText !== text ? { displayText: extra.displayText } : {}),
		}).then(group => {
			haptic.success();
			if (router.canDismiss()) {
				router.dismiss();
				router.push({ pathname: '/group/[id]', params: { id: group.id } });
			} else {
				router.replace({ pathname: '/group/[id]', params: { id: group.id } });
			}
		}, err => client.toast('error', `Could not start the runs: ${errorMessage(err)}`)).finally(() => setStarting(false));
		return true;
	};

	const projectActions: ISheetAction[] = [
		...projects.map(pr => ({ label: pr.name, detail: shortPath(pr.path, 44), icon: 'folder' as const, checked: pr.id === projectId, onPress: () => setProjectId(pr.id) })),
		{ label: 'Add a project folder…', icon: 'folderPlus', onPress: () => setAdding(true) },
	];

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6 }}>
				<IconButton icon="close" label="Close" onPress={() => router.back()} style={{ backgroundColor: p.fill }} />
				<T variant="title3" weight="700" align="center" style={{ flex: 1 }}>New chat</T>
				<View style={{ width: 36 }} />
			</View>
			<KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
				<ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 18 }} keyboardShouldPersistTaps="handled">
					<Tap haptics="selection" onPress={() => projects.length ? setPicking(true) : setAdding(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, backgroundColor: p.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke }}>
						<View style={{ width: 40, height: 40, borderRadius: 11, backgroundColor: p.fill, alignItems: 'center', justifyContent: 'center' }}>
							<Icon name={project ? 'folder' : 'folderPlus'} size={20} color={p.fgSecondary} />
						</View>
						<View style={{ flex: 1 }}>
							<T variant="footnote" color={p.fgTertiary}>Project on {client.environment.label}</T>
							<T variant="callout" weight="600" numberOfLines={1}>{project?.name ?? 'Add a project'}</T>
							{project ? <T variant="caption" mono color={p.fgQuaternary} numberOfLines={1}>{shortPath(project.path, 48)}</T> : null}
						</View>
						<Icon name="chevronsUpDown" size={16} color={p.fgTertiary} />
					</Tap>

					<View style={{ gap: 8 }}>
						<T variant="caption" weight="700" color={p.fgTertiary} style={{ letterSpacing: 0.6, marginLeft: 4 }}>TRY</T>
						{SUGGESTIONS.map(s => (
							<Tap key={s.text} haptics="light" onPress={() => start(s.text)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, height: 48, borderRadius: 14, backgroundColor: p.fillFaint, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
								<Icon name={s.icon} size={17} color={p.fgTertiary} />
								<T variant="body" color={p.fgSecondary} style={{ flex: 1 }} numberOfLines={1}>{s.text}</T>
								<Icon name="arrowUp" size={15} color={p.fgQuaternary} />
							</Tap>
						))}
					</View>

					{recent.length ? (
						<View style={{ gap: 4 }}>
							<T variant="caption" weight="700" color={p.fgTertiary} style={{ letterSpacing: 0.6, marginLeft: 4, marginBottom: 4 }}>{`RECENT IN ${(project?.name ?? '').toUpperCase()}`}</T>
							{recent.map(item => (
								<Tap key={item.id} haptics="selection" onPress={() => {
									router.dismiss();
									router.push({ pathname: '/chat/[id]', params: { id: item.id } });
								}} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, height: 44, borderRadius: 12 }}>
									<StatusIcon status={item.status} size={14} />
									<T variant="body" numberOfLines={1} style={{ flex: 1 }}>{item.title}</T>
									<Icon name="chevronRight" size={14} color={p.fgQuaternary} />
								</Tap>
							))}
						</View>
					) : null}
				</ScrollView>
				<View style={{ paddingBottom: Math.max(insets.bottom, 10), paddingTop: 6 }}>
					<Composer
						draftKey="new"
						autoFocus
						mode={mode}
						onModeChange={setMode}
						modelRef={effectiveModel}
						onModelChange={ref => {
							setModelTouched(true);
							setModelRef(ref);
						}}
						multiModels={multi}
						onMultiModelsChange={setMulti}
						accessMode={access ?? runtime.accessMode}
						onAccessChange={setAccess}
						onSend={(text, _delivery, attachments, extra) => start(text, attachments, extra)}
						folder={project?.path}
						placeholder={!project ? 'Add a project to start' : multi ? `One prompt for ${multi.length} models in ${project.name}` : `What should Volt do in ${project.name}?`}
						leading={project ? <Pill label={project.name} icon="folder" onPress={() => setPicking(true)} maxWidth={110} /> : undefined}
					/>
				</View>
			</KeyboardAvoidingView>
			<ActionSheet visible={picking} onClose={() => setPicking(false)} title="Project" actions={projectActions} />
			<InputSheet visible={adding} onClose={() => setAdding(false)} title="Add a project folder" placeholder="~/code/my-app" confirm="Add" onSubmit={path => {
				if (!path.trim()) {
					return;
				}
				void client.addProject(expandHome(path, projects)).then(added => {
					if (added) {
						haptic.success();
						setProjectId(added.id);
					}
				});
			}} />
		</View>
	);
}
