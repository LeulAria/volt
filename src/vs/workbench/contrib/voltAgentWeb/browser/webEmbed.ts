/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { $, append } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { agentTurnStatus } from '../../../services/voltAgentServer/common/agentClientServices.js';
import { AgentQuestionTray } from '../../voltAgent/browser/composer/agentQuestionTray.js';
import { WebAgentServices } from './webServices.js';
import { WebThread } from './webThread.js';
import { EmbedCommand, EmbedEvent } from '../common/embedProtocol.js';

interface IEmbedHost {
	postMessage(message: string): void;
}

/**
 * The thread alone, for the mobile app: the native app draws home, pickers and the composer and
 * shows this page in a web view, so the transcript is the agent window's own renderer there too.
 * The page follows commands from the app (`window.voltEmbed.receive`) and posts its state back.
 */
export function startEmbeddedThread(services: WebAgentServices, workbench: HTMLElement): void {
	workbench.classList.add('volt-web-embed');
	mainWindow.document.documentElement.classList.add('volt-web-embedded');
	const host = (mainWindow as unknown as { ReactNativeWebView?: IEmbedHost }).ReactNativeWebView;
	const post = (event: EmbedEvent) => host?.postMessage(JSON.stringify(event));

	const right = append(workbench, $('.volt-web-right'));
	const editorPart = append(right, $('.part.editor'));
	const content = append(editorPart, $('.content'));
	const thread = new WebThread(services);
	content.appendChild(thread.element);
	thread.enableTouchScrolling();

	// Questions the agent asks wait in the window's tray, under the thread.
	const dock = append(thread.main, $('.volt-agent-composer.volt-web-embed-dock'));
	const tray = new AgentQuestionTray({
		onSubmit: (requestId, response) => services.runtime.respondToQuestions(requestId, response),
		onLayout: () => thread.layout(),
	});
	dock.appendChild(tray.element);
	const syncQuestions = () => {
		const pending = thread.sessionId ? services.runtime.getPendingQuestions(thread.sessionId) : [];
		tray.setRequest(pending[0]);
		dock.classList.toggle('hidden', !pending.length);
		thread.layout();
	};
	services.runtime.onDidChangeQuestions(id => id === thread.sessionId && syncQuestions());

	let scrolledUp = false;
	const postState = () => {
		const lastAgent = [...thread.messages].reverse().find(message => message.kind === 'agent');
		post({
			type: 'state',
			chat: thread.sessionId,
			messages: thread.messages.length,
			streaming: thread.isStreaming,
			status: agentTurnStatus(lastAgent, thread.isStreaming).label,
			scrolledUp,
			connected: services.client.connection.state === 'open',
		});
	};
	thread.onDidChange(() => postState());
	thread.onDidChangeScrolledUp(up => {
		scrolledUp = up;
		postState();
	});
	services.client.onDidChangeState(() => postState());
	// The live phrase and "Working 12s" move between patches too.
	mainWindow.setInterval(() => thread.isStreaming && postState(), 1000);

	const session = new DisposableStore();
	const receive = async (command: EmbedCommand) => {
		switch (command.type) {
			case 'open':
				session.clear();
				await thread.open(command.chat);
				syncQuestions();
				postState();
				break;
			case 'clear':
				thread.clear(command.chat);
				syncQuestions();
				postState();
				break;
			case 'scrollToEnd':
				thread.scrollToEnd();
				break;
			case 'insets':
				workbench.style.setProperty('--volt-embed-inset-top', `${command.top}px`);
				workbench.style.setProperty('--volt-embed-inset-bottom', `${command.bottom}px`);
				thread.layout();
				break;
		}
	};
	(mainWindow as unknown as { voltEmbed: { receive: (command: EmbedCommand) => Promise<void> } }).voltEmbed = { receive };

	// Links open in the phone's browser, not in place of the thread.
	mainWindow.document.addEventListener('click', e => {
		const anchor = (e.target as HTMLElement | null)?.closest?.('a[href]');
		const href = anchor?.getAttribute('href');
		if (href && /^https?:/i.test(href)) {
			e.preventDefault();
			e.stopPropagation();
			post({ type: 'link', url: href });
		}
	}, true);

	const initial = new URLSearchParams(location.hash.slice(1)).get('chat');
	void (async () => {
		await services.start();
		await services.client.whenReady;
		if (initial) {
			await receive({ type: 'open', chat: initial });
		}
		post({ type: 'ready' });
	})();
}
