/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Volt web app: the agent window's chat, served by the agent server. Same components and CSS
// as the window; state and runs come from the server.

import '../../../browser/media/style.css';
import '../../../../base/browser/ui/codicons/codicon/codicon.css';
import '../../../../base/browser/ui/codicons/codicon/codicon-modifiers.css';
import '../../voltAgent/browser/media/agentEditor.css';
import '../../voltAgent/browser/media/agentSidePanel.css';
import '../../voltAgent/browser/media/agentTitlebarHeader.css';
import '../../voltAgent/browser/media/agentViewSidebars.css';
import '../../voltAgent/browser/media/agentImages.css';
import './media/desktopTheme.css';
import './media/desktopFileIcons.css';
import './media/web.css';

import { mainWindow } from '../../../../base/browser/window.js';
import { $, append } from '../../../../base/browser/dom.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { WebAgentServices, takeToken } from './webServices.js';
import { WebComposer } from './webComposer.js';
import { WebHome } from './webHome.js';
import { WebThread } from './webThread.js';
import { startEmbeddedThread } from './webEmbed.js';

/** Root classes the agent window's CSS keys on (captured from the window, Cursor Dark, macOS look). */
const WORKBENCH_CLASSES = ['monaco-workbench', 'volt-web', 'file-icons-enabled', 'volt-layout-agent', 'volt-single-agent', 'enable-motion', 'mac', 'chromium', 'nosidebar', 'nopanel', 'nostatusbar', 'macos-bigsur-or-newer', 'vs-dark', 'volt-theme-cursor-themes-cursor-dark-color-theme-json'];

/** Set by the Volt Agents app's preload (apps/desktop/src/preload.ts); absent in a browser. */
interface IVoltShell {
	readonly platform: string;
	onCommand(listener: (command: string) => void): void;
}
const voltShell = (mainWindow as unknown as { voltShell?: IVoltShell }).voltShell;

function chatFromHash(): string | undefined {
	const id = new URLSearchParams(location.hash.slice(1)).get('chat');
	return id && /^[\w.-]+$/.test(id) ? id : undefined;
}

function setChatHash(sessionId: string | undefined): void {
	const params = new URLSearchParams(location.hash.slice(1));
	if (sessionId) {
		params.set('chat', sessionId);
	} else {
		params.delete('chat');
	}
	history.replaceState(null, '', `${location.pathname}${location.search}#${params.toString()}`);
}

async function main(): Promise<void> {
	mainWindow.document.documentElement.classList.add('volt-layout-agent-window');
	const token = takeToken();
	if (!token) {
		const signIn = append(mainWindow.document.body, $('.volt-web-signin'));
		append(signIn, $('img.volt-web-signin-logo', { src: '/brand/volt-180.png', alt: '' }));
		append(signIn, $('.volt-web-signin-title')).textContent = 'Volt';
		append(signIn, $('.volt-web-signin-text')).textContent = localize('voltWeb.noToken', "Open the Volt web app from Volt (Volt: Open Agent Web App) so it can sign in.");
		return;
	}
	const services = new WebAgentServices(token);
	const workbench = append(mainWindow.document.body, $('div'));
	workbench.classList.add(...WORKBENCH_CLASSES);
	if (voltShell) {
		// Volt Agents: vibrancy behind the page, traffic lights over the sidebar's top-left corner.
		mainWindow.document.documentElement.classList.add('volt-shell');
		workbench.classList.add('volt-shell');
	}
	if (new URLSearchParams(location.search).get('embed') === 'thread') {
		startEmbeddedThread(services, workbench);
		return;
	}

	const sidebar = append(workbench, $('.part.auxiliarybar.basepanel.left.pane-composite-part.volt-agent-home'));
	// Where the window has its traffic lights, the page shows Volt's mark.
	const brand = append(sidebar, $('.volt-web-brand'));
	append(brand, $('img.volt-web-brand-logo', { src: '/brand/volt-64.png', alt: '' }));
	append(brand, $('span.volt-web-brand-name')).textContent = 'Volt';
	const sideMain = append(append(append(sidebar, $('.content')), $('.pane-body.volt-agent-side-panel.home-mode')), $('.volt-agent-side-main'));
	const home = new WebHome(services);
	sideMain.appendChild(home.element);

	const right = append(workbench, $('.volt-web-right'));
	const titlebar = append(right, $('.part.titlebar'));
	const titleLeft = append(append(titlebar, $('.titlebar-container')), $('.titlebar-left'));
	const header = append(titleLeft, $('.volt-agent-primary-header'));
	const headerTitle = append(header, $('.volt-agent-primary-header-title'));
	const headerProject = append(headerTitle, $('span.volt-agent-primary-header-project'));
	const headerSeparator = append(headerTitle, $('span.volt-agent-primary-header-separator'));
	headerSeparator.textContent = '/';
	const headerLabel = append(headerTitle, $('span.volt-agent-primary-header-label'));

	const editorPart = append(right, $('.part.editor'));
	const content = append(editorPart, $('.content'));
	const thread = new WebThread(services);
	content.appendChild(thread.element);
	const composer = new WebComposer(services, thread);
	thread.main.appendChild(composer.element);

	const banner = append(mainWindow.document.body, $('.volt-web-banner'));
	banner.style.display = 'none';
	services.client.onDidChangeState(state => {
		banner.textContent = state === 'open' ? '' : localize('voltWeb.reconnecting', "Reconnecting to the Volt agent server…");
		banner.style.display = state === 'open' ? 'none' : '';
	});
	services.client.connection.onDidFail(() => {
		banner.textContent = localize('voltWeb.signedOut', "The agent server did not accept this page. Open it again from Volt.");
		banner.style.display = '';
	});

	const refreshHeader = () => {
		const sessionId = thread.sessionId;
		const meta = sessionId ? services.history.get(sessionId) : undefined;
		const project = sessionId ? services.projects.bindingFor(sessionId) : undefined;
		const projectName = project ? services.projects.getProject(project.projectId)?.displayName : services.projects.activeProject?.displayName;
		headerProject.textContent = projectName ?? '';
		headerSeparator.style.display = projectName && thread.messages.length ? '' : 'none';
		const title = meta?.title || '';
		headerLabel.textContent = thread.messages.length ? title.split(/\s+/).slice(0, 3).join(' ') : '';
		document.title = title ? `${title} · Volt` : 'Volt';
	};

	const openChat = async (sessionId: string) => {
		setChatHash(sessionId);
		home.setActive(sessionId);
		composer.setSession(sessionId);
		await thread.open(sessionId);
		refreshHeader();
		composer.focus();
	};
	const newChat = () => {
		const sessionId = `agent-${generateUuid()}`;
		setChatHash(undefined);
		home.setActive(undefined);
		thread.clear(sessionId);
		composer.setSession(sessionId);
		refreshHeader();
		composer.focus();
	};

	home.onDidOpen(id => void openChat(id));
	home.onDidNewChat(() => newChat());
	voltShell?.onCommand(command => {
		if (command === 'newChat') {
			newChat();
		}
	});
	composer.onDidSend(id => {
		if (thread.sessionId !== id || !thread.messages.length) {
			void openChat(id);
		}
	});
	thread.onDidChange(() => refreshHeader());
	services.history.onDidChange(() => refreshHeader());

	await services.start();
	await services.client.whenReady;
	const initial = chatFromHash();
	if (initial) {
		await openChat(initial);
	} else {
		newChat();
	}
}

void main();
