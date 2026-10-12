/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type AccessMode, type ComposerMode, type IPromptAttachment, selectProjects, shortPath } from '@volt/client-core';
import { useEffect, useMemo, useState } from 'react';
import { useChatItems, useClient, useCollections, useRuntime, useStatus } from '../app/client';
import { chatPath, navigate } from '../app/router';
import { Composer } from '../chat/Composer';
import { Dialog, type IMenuItem, MenuButton } from '../ui/overlays';
import { Button, Icon, IconButton, StatusIcon } from '../ui/primitives';

const LAST_PROJECT_KEY = 'volt.web.lastProject';

const SUGGESTIONS = [
	{ icon: 'search' as const, text: 'Explain how this project is structured' },
	{ icon: 'alertCircle' as const, text: 'Find and fix the failing tests' },
	{ icon: 'sparkles' as const, text: 'Review my uncommitted changes' },
	{ icon: 'listChecks' as const, text: 'Plan the next feature with me' },
];

export function NewChat({ initialProjectId, compact, onStarted }: { readonly initialProjectId?: string; readonly compact?: boolean; readonly onStarted?: (chatId: string) => void }) {
	const client = useClient();
	const runtime = useRuntime();
	const status = useStatus();
	const items = useChatItems();
	const cols = useCollections(['projects', 'history']);
	const projects = useMemo(() => selectProjects(cols), [cols]);
	const [projectId, setProjectId] = useState<string | undefined>(() => initialProjectId ?? readLastProject());
	const [mode, setMode] = useState<ComposerMode>('Agent');
	const [modelRef, setModelRef] = useState<string | undefined>(undefined);
	const [modelTouched, setModelTouched] = useState(false);
	const [access, setAccess] = useState<AccessMode | undefined>(undefined);
	const [adding, setAdding] = useState(false);

	useEffect(() => {
		if (!projects.length) {
			return;
		}
		if (!projectId || !projects.some(p => p.id === projectId)) {
			setProjectId(projects[0].id);
		}
	}, [projects, projectId]);

	const project = projects.find(p => p.id === projectId);
	const effectiveModel = modelTouched ? modelRef : runtime.activeCatalogRef;
	const recent = items.filter(item => !item.archived && item.projectId === projectId).slice(0, 4);

	const projectItems: IMenuItem[] = [
		...(projects.length ? [{ id: 'h', label: 'Projects', header: true }] : []),
		...projects.map(p => ({ id: p.id, label: p.name, icon: 'folder' as const, detail: shortPath(p.path, 40), checked: p.id === projectId, onSelect: () => setProjectId(p.id) })),
		{ id: 'sep', label: '', separator: true },
		{ id: 'add', label: 'Add a project folder…', icon: 'folderPlus', onSelect: () => setAdding(true) },
	];

	const start = (text: string, attachments: readonly IPromptAttachment[] = []) => {
		if (!projectId) {
			setAdding(true);
			return false;
		}
		try {
			window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
		} catch {
			// private mode
		}
		const id = client.startChat({ projectId, text, mode, ...(effectiveModel ? { modelRef: effectiveModel } : {}), ...(access ? { accessMode: access } : {}), ...(attachments.length ? { attachments } : {}) });
		if (onStarted) {
			onStarted(id);
		} else {
			navigate(chatPath(id));
		}
		return true;
	};

	return (
		<div className={`newchat${compact ? ' compact' : ''}`}>
			<div className="newchat-center">
				<div className="newchat-hero">
					<div className="hero-mark"><Icon name="bolt" size={22} /></div>
					<h1>What should Volt do{project ? <> in <span className="hero-project">{project.name}</span></> : null}?</h1>
					<p className="hero-sub">It runs on {client.environment.label}. Keep going here, on your phone, or at your desk.</p>
				</div>
				<Composer
					draftKey="new"
					large
					autoFocus
					mode={mode}
					onModeChange={setMode}
					modelRef={effectiveModel}
					onModelChange={ref => {
						setModelTouched(true);
						setModelRef(ref);
					}}
					accessMode={access ?? runtime.accessMode}
					onAccessChange={setAccess}
					onSend={(text, _delivery, attachments) => start(text, attachments)}
					mentionRoot={project?.path}
					acceptsInserts
					placeholder={project ? `Ask Volt to work in ${project.name}… @ to mention a file` : 'Add a project to start'}
					compact={compact}
					disabled={!status.live && !status.ready}
					leading={
						<MenuButton className="pill pill-project" items={projectItems} placement="top-start" width={320} label="Project">
							<Icon name="folder" size={13} /><span className="pill-text">{project?.name ?? 'Choose a project'}</span><Icon name="chevronDown" size={11} />
						</MenuButton>
					}
				/>
				<div className="suggestions">
					{SUGGESTIONS.map(s => (
						<button key={s.text} type="button" className="suggestion" onClick={() => project ? start(s.text) : setAdding(true)}>
							<Icon name={s.icon} size={14} />{s.text}
						</button>
					))}
				</div>
				{recent.length ? (
					<div className="recent">
						<div className="recent-title">Recent in {project?.name}</div>
						{recent.map(item => (
							<button key={item.id} type="button" className="recent-row" onClick={() => navigate(chatPath(item.id))}>
								<StatusIcon status={item.status} size={13} />
								<span className="recent-name">{item.title}</span>
								<Icon name="chevronRight" size={12} />
							</button>
						))}
					</div>
				) : null}
			</div>
			<AddProjectDialog open={adding} onClose={() => setAdding(false)} onAdded={id => setProjectId(id)} />
		</div>
	);
}

function readLastProject(): string | undefined {
	try {
		return window.localStorage.getItem(LAST_PROJECT_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

/** `~/code/app` with the home folder the known projects live under (the server has no shell to expand it). */
function expandHome(path: string, known: readonly string[]): string {
	const trimmed = path.trim();
	if (!trimmed.startsWith('~')) {
		return trimmed;
	}
	const home = known.map(p => /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(p)?.[1]).find(Boolean);
	return home ? `${home}${trimmed.slice(1)}` : trimmed;
}

export function AddProjectDialog({ open, onClose, onAdded }: { readonly open: boolean; readonly onClose: () => void; readonly onAdded: (id: string) => void }) {
	const client = useClient();
	const cols = useCollections(['projects', 'history']);
	const known = useMemo(() => selectProjects(cols).map(p => p.path), [cols]);
	const [path, setPath] = useState('');
	const [busy, setBusy] = useState(false);
	const submit = async () => {
		if (!path.trim()) {
			return;
		}
		setBusy(true);
		const project = await client.addProject(expandHome(path, known));
		setBusy(false);
		if (project) {
			onAdded(project.id);
			setPath('');
			onClose();
		}
	};
	return (
		<Dialog open={open} onClose={onClose} title="Add a project" footer={<>
			<Button variant="ghost" onClick={onClose}>Cancel</Button>
			<Button variant="primary" busy={busy} disabled={!path.trim()} onClick={() => void submit()}>Add project</Button>
		</>}>
			<div className="dialog-text">The folder on {client.environment.label} where Volt should work.</div>
			<div className="input-row">
				<Icon name="folder" size={14} />
				<input className="input bare mono" autoFocus placeholder="~/code/my-app" value={path} onChange={e => setPath(e.target.value)} onKeyDown={e => e.key === 'Enter' && void submit()} />
				{path ? <IconButton icon="close" label="Clear" size={12} onClick={() => setPath('')} /> : null}
			</div>
		</Dialog>
	);
}
