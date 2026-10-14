/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { useMe } from '../lib/data';
import { DEFAULT_PANEL, DEFAULT_SIDEBAR, getWorkbench, setPanelHeight, setSidebarWidth, useWorkbench } from '../lib/workbench';
import { Codicon } from '../ui/icons';
import { Sash } from '../ui/layout';
import { ContextMenuHost, DialogHost, Modal, NotificationHost } from '../ui/overlays';
import { ActivityBar, StatusBar, switchOrganization, TitleBar, useGlobalKeys } from './Chrome';
import { open } from './commands';
import { EditorPart } from './EditorPart';
import { Panel } from './Panel';
import { QuickInput } from './QuickInput';
import { Sidebar } from './Sidebar';

/**
 * The console as a VS Code workbench: title bar, activity bar, a resizable side bar of views,
 * the editor area with tabs, a resizable bottom panel, and the status bar.
 */
export function Workbench() {
	const sidebarVisible = useWorkbench(s => s.sidebarVisible);
	const sidebarWidth = useWorkbench(s => s.sidebarWidth);
	const panelVisible = useWorkbench(s => s.panelVisible);
	const panelHeight = useWorkbench(s => s.panelHeight);
	const { data: me } = useMe();
	useGlobalKeys();

	// First visit: Get Started for admins, My Access for developers.
	useEffect(() => {
		if (!getWorkbench().editors.length) {
			if (me?.role && me.role !== 'member') {
				open.welcome();
			} else {
				open.myAccess();
			}
		}
	}, [me?.role]);

	const [picking, setPicking] = useState(false);
	useEffect(() => {
		const onSwitch = () => setPicking(true);
		window.addEventListener('govern:switch-org', onSwitch);
		return () => window.removeEventListener('govern:switch-org', onSwitch);
	}, []);

	return (
		<div className="workbench">
			<TitleBar />
			<div className="wb-main">
				<ActivityBar />
				{sidebarVisible ? (
					<>
						<div className="wb-sidebar-slot" style={{ width: sidebarWidth }}><Sidebar /></div>
						<Sash orientation="vertical" size={sidebarWidth} min={170} max={640} onResize={setSidebarWidth} onReset={() => setSidebarWidth(DEFAULT_SIDEBAR)} />
					</>
				) : null}
				<div className="wb-center">
					<EditorPart />
					{panelVisible ? (
						<>
							<Sash orientation="horizontal" invert size={panelHeight} min={100} max={Math.max(160, window.innerHeight - 220)} onResize={setPanelHeight} onReset={() => setPanelHeight(DEFAULT_PANEL)} />
							<div className="wb-panel-slot" style={{ height: panelHeight }}><Panel /></div>
						</>
					) : null}
				</div>
			</div>
			<StatusBar />
			<QuickInput />
			<ContextMenuHost />
			<DialogHost />
			<NotificationHost />
			{picking && me ? (
				<Modal title="Switch Organization" onClose={() => setPicking(false)}>
					<div className="list" style={{ margin: '0 -18px' }}>
						{me.organizations.map(o => (
							<div key={o.id} className={`list-row${o.id === me.organization?.id ? ' selected' : ''}`} onClick={() => { setPicking(false); void switchOrganization(o.id); }}>
								<Codicon name="organization" /><span className="list-label">{o.name}</span><span className="list-desc">{o.slug}</span>
							</div>
						))}
						<div className="list-row" onClick={() => window.location.assign('/onboarding')}><Codicon name="add" /><span className="list-label">Create Organization…</span></div>
					</div>
				</Modal>
			) : null}
		</div>
	);
}
