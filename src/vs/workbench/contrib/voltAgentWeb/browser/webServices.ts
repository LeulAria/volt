/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { MarkdownRenderer } from '../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { LanguageService } from '../../../../editor/common/services/languageService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IWebSocketLike } from '../../../../platform/voltAgentServer/common/connection.js';
import { AgentClientServices } from '../../../services/voltAgentServer/common/agentClientServices.js';
import { FileChangePreview } from '../../voltAgent/browser/review/fileChangePreview.js';
import { WebFileChangePreview } from './webFileChangePreview.js';
import { setUpWebTokenization } from './webTokenization.js';

const TOKEN_KEY = 'volt.agentServer.token';

/** The token from the URL the desktop opened (`#token=…`), kept for this tab and taken out of the URL. */
export function takeToken(): string | undefined {
	const hash = new URLSearchParams(location.hash.slice(1));
	const fromHash = hash.get('token');
	if (fromHash) {
		sessionStorage.setItem(TOKEN_KEY, fromHash);
		hash.delete('token');
		const rest = hash.toString();
		history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
		return fromHash;
	}
	return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
}

/** Storage for the web app's own choices (selected project, layout); per browser. */
class WebStorage {
	get(key: string, _scope?: unknown, fallback = ''): string {
		return localStorage.getItem(key) ?? fallback;
	}
	store(key: string, value: string): void {
		localStorage.setItem(key, value);
	}
	remove(key: string): void {
		localStorage.removeItem(key);
	}
}

/**
 * The services the web app renders with. Agent state comes from the agent server through the
 * shared client services (the same remote services the desktop window uses); rendering uses the
 * agent window's own modules.
 */
export class WebAgentServices extends AgentClientServices {

	readonly languageService: LanguageService;
	readonly markdownRenderer: MarkdownRenderer;
	readonly instantiationService: IInstantiationService;

	constructor(token: string) {
		const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
		super({
			kind: 'web',
			endpoint: async () => ({ url, token }),
			createSocket: target => new WebSocket(target) as unknown as IWebSocketLike,
			storage: new WebStorage(),
			onError: (method, err) => console.warn(`[volt] ${method} failed`, err),
		});
		this.languageService = this._register(new LanguageService());
		const opener: Partial<IOpenerService> = {
			open: async (target: URI | string) => {
				mainWindow.open(typeof target === 'string' ? target : target.toString(true), '_blank', 'noopener');
				return true;
			},
		};
		this.markdownRenderer = new MarkdownRenderer({}, this.languageService, opener as IOpenerService);
		const noModels: Partial<IModelService> = { getModel: () => null };
		const services = new ServiceCollection(
			[ILanguageService, this.languageService],
			[IModelService, noModels],
		);
		const instantiation = this._register(new InstantiationService(services, true));
		// The diff card is a Monaco diff editor in the window; here it is drawn in DOM.
		const createInstance = instantiation.createInstance.bind(instantiation) as (ctor: unknown, ...args: unknown[]) => unknown;
		(instantiation as unknown as { createInstance: (ctor: unknown, ...args: unknown[]) => unknown }).createInstance = (ctor: unknown, ...args: unknown[]) =>
			ctor === FileChangePreview ? new WebFileChangePreview(this.languageService) : createInstance(ctor, ...args);
		this.instantiationService = instantiation;
	}

	async start(): Promise<void> {
		this.connect();
		this._register(await setUpWebTokenization(this.languageService));
	}
}
