/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Component, type ComponentType, type ErrorInfo, type ReactNode, Suspense, lazy, useEffect } from 'react';
import { useOrg } from '../lib/data';
import { keys } from '../lib/format';
import { closeEditor, closeEditors, type EditorKind, type IEditorInput, pinEditor, setActiveEditor, useWorkbench } from '../lib/workbench';
import { Button, EmptyState, Kbd } from '../ui/controls';
import { Bolt, Codicon } from '../ui/icons';
import { confirm, showContextMenu } from '../ui/overlays';

export interface IEditorProps {
	readonly input: IEditorInput;
}

const EDITORS: Record<EditorKind, ComponentType<IEditorProps>> = {
	'welcome': lazy(() => import('../editors/WelcomeEditor')),
	'overview': lazy(() => import('../editors/OverviewEditor')),
	'alerts': lazy(() => import('../editors/AlertsEditor')),
	'my-access': lazy(() => import('../editors/MyAccessEditor')),
	'members': lazy(() => import('../editors/MembersEditor')),
	'member': lazy(() => import('../editors/MemberEditor')),
	'team': lazy(() => import('../editors/TeamEditor')),
	'invitations': lazy(() => import('../editors/MembersEditor').then(m => ({ default: m.InvitationsEditor }))),
	'credentials': lazy(() => import('../editors/CredentialsEditor')),
	'credential': lazy(() => import('../editors/CredentialEditor')),
	'models': lazy(() => import('../editors/ModelsEditor')),
	'policy': lazy(() => import('../editors/PolicyEditor')),
	'mcp': lazy(() => import('../editors/McpEditor')),
	'mcp-server': lazy(() => import('../editors/McpServerEditor')),
	'skills': lazy(() => import('../editors/SkillsEditor')),
	'skill': lazy(() => import('../editors/SkillEditor')),
	'usage': lazy(() => import('../editors/UsageEditor')),
	'requests': lazy(() => import('../editors/RequestsEditor')),
	'playground': lazy(() => import('../editors/PlaygroundEditor')),
	'activity': lazy(() => import('../editors/ActivityEditor')),
	'devices': lazy(() => import('../editors/DevicesEditor')),
	'audit': lazy(() => import('../editors/AuditEditor')),
	'identity': lazy(() => import('../editors/IdentityEditor')),
	'settings': lazy(() => import('../editors/SettingsEditor')),
};

/** Closes an editor, asking first when it has unsaved changes (VS Code's dirty close). */
export async function requestClose(editor: IEditorInput): Promise<void> {
	if (editor.dirty && !await confirm({ title: `Discard changes to ${editor.title}?`, message: 'Your changes will be lost if you close this editor without saving.', primary: "Don't Save", danger: true })) {
		return;
	}
	closeEditor(editor.id);
}

const BREADCRUMB_ROOT: Partial<Record<EditorKind, string>> = {
	'member': 'People', 'team': 'People', 'members': 'People', 'invitations': 'People',
	'credential': 'Models & Keys', 'credentials': 'Models & Keys', 'models': 'Models & Keys',
	'policy': 'Policies', 'mcp': 'MCP', 'mcp-server': 'MCP', 'skills': 'Skills', 'skill': 'Skills',
	'usage': 'Insights', 'requests': 'Insights', 'playground': 'Insights', 'activity': 'Insights', 'devices': 'Security', 'audit': 'Security', 'identity': 'Security', 'settings': 'Settings',
};

function Tabs() {
	const editors = useWorkbench(s => s.editors);
	const activeId = useWorkbench(s => s.activeId);
	return (
		<div className="tabs-bar">
			<div className="tabs" role="tablist">
				{editors.map(e => (
					<div key={e.id} role="tab" aria-selected={e.id === activeId} tabIndex={0} title={e.description ? `${e.title} · ${e.description}` : e.title}
						className={`tab${e.id === activeId ? ' active' : ''}${e.preview ? ' preview' : ''}${e.dirty ? ' dirty' : ''}`}
						onClick={() => setActiveEditor(e.id)}
						onDoubleClick={() => pinEditor(e.id)}
						onAuxClick={ev => { if (ev.button === 1) { void requestClose(e); } }}
						onKeyDown={ev => ev.key === 'Enter' && setActiveEditor(e.id)}
						onContextMenu={ev => showContextMenu(ev, [
							{ id: 'close', label: 'Close', keys: keys('⌘W'), run: () => void requestClose(e) },
							{ id: 'others', label: 'Close Others', run: () => closeEditors(x => x.id !== e.id && !x.dirty) },
							{ id: 'right', label: 'Close to the Right', run: () => { const i = editors.findIndex(x => x.id === e.id); closeEditors(x => editors.indexOf(x) > i && !x.dirty); } },
							{ id: 'saved', label: 'Close Saved', run: () => closeEditors(x => !x.dirty) },
							{ id: 's', separator: true },
							{ id: 'pin', label: e.preview ? 'Keep Open' : 'Kept Open', disabled: !e.preview, run: () => pinEditor(e.id) },
						])}>
						<Codicon name={e.icon} />
						<span className="tab-label">{e.title}</span>
						{e.description ? <span className="tab-desc">{e.description}</span> : null}
						<button type="button" className="tab-close" aria-label={`Close ${e.title}`} onClick={ev => { ev.stopPropagation(); void requestClose(e); }}>
							<span className="tab-dirty" />
							<Codicon name="close" />
						</button>
					</div>
				))}
			</div>
		</div>
	);
}

function Watermark() {
	const { orgName } = useOrg();
	const shortcuts: [string, string][] = [
		['Show All Commands', keys('⇧⌘P')],
		['Go to Member, Team, Skill…', keys('⌘P')],
		['Toggle Side Bar', keys('⌘B')],
		['Toggle Panel', keys('⌘J')],
		['Organization Settings', keys('⌘,')],
	];
	return (
		<div className="empty-editor">
			<div className="watermark"><Bolt size={120} /></div>
			<div className="muted">{orgName}</div>
			<dl>
				{shortcuts.map(([label, k]) => <div key={label} style={{ display: 'contents' }}><dt>{label}</dt><dd><Kbd>{k}</Kbd></dd></div>)}
			</dl>
		</div>
	);
}

/** One editor failing to render shows its error in place; the rest of the workbench keeps working. */
class EditorBoundary extends Component<{ readonly children: ReactNode }, { readonly error?: Error }> {
	override state: { readonly error?: Error } = {};
	static getDerivedStateFromError(error: Error) {
		return { error };
	}
	override componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error('[volt-govern] editor crashed', error, info.componentStack);
	}
	override render() {
		if (!this.state.error) {
			return this.props.children;
		}
		return (
			<div className="page">
				<EmptyState icon="error" title="This view could not be shown" actions={<><Button onClick={() => this.setState({ error: undefined })}>Try Again</Button><Button variant="ghost" onClick={() => window.location.reload()}>Reload</Button></>}>
					{this.state.error.message || 'An unexpected error occurred.'}
				</EmptyState>
			</div>
		);
	}
}

export function EditorPart() {
	const editors = useWorkbench(s => s.editors);
	const activeId = useWorkbench(s => s.activeId);
	const active = editors.find(e => e.id === activeId);
	const { orgName } = useOrg();
	useEffect(() => {
		document.title = active ? `${active.title} · ${orgName} · Volt Govern` : `${orgName} · Volt Govern`;
	}, [active?.title, orgName]);
	if (!active) {
		return <div className="wb-editor"><Watermark /></div>;
	}
	const Editor = EDITORS[active.kind];
	const root = BREADCRUMB_ROOT[active.kind];
	return (
		<div className="wb-editor">
			<Tabs />
			<nav className="breadcrumbs" aria-label="Breadcrumbs">
				{root ? <><span className="crumb">{root}</span><Codicon name="chevron-right" /></> : null}
				<span className="crumb"><Codicon name={active.icon} />{active.title}</span>
			</nav>
			<div className="editor-body">
				<EditorBoundary key={active.id}>
					<Suspense fallback={<div className="editor-progress" />}>
						{/* Keyed by editor: switching tabs gives each editor its own state, like VS Code's editor inputs. */}
						<Editor key={active.id} input={active} />
					</Suspense>
				</EditorBoundary>
			</div>
		</div>
	);
}
