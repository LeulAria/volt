/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Color } from '../../../../../base/common/color.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IVoltVisualPreviewService } from '../../../../../platform/voltVisualPreview/common/voltVisualPreview.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltVisualRef } from '../../../../services/voltRuntime/common/hostTools.js';
import { WebviewThemeDataProvider } from '../../../webview/browser/themeing.js';
import { PAGE_MEASURE_WIDTHS } from './agentVisualBridge.js';
import { buildVisualPage, VISUAL_COLUMN_WIDTH, VISUAL_MAX_HEIGHT, VISUAL_MIN_HEIGHT } from './agentVisualPage.js';
import { themeKind, visualThemeCss } from './agentVisuals.js';

export interface IPublishedPage {
	readonly visual: IVoltVisualRef;
	/** Errors the page logged while it loaded offscreen: the reader may see it broken. */
	readonly errors: readonly string[];
	/** A PNG of the page at the reply column's width, when `screenshot` was asked for. */
	readonly png?: string;
}

/**
 * Publishes a page to the chat: stores it (the transcript draws it from the store), measures it
 * offscreen at the widths a chat can have, so its frame opens at the right height (no jump when
 * it loads), and reports the errors it logged on the way. Shared by html_render and the galleries.
 */
export class VisualPagePublisher extends Disposable {

	private readonly webviewTheme: WebviewThemeDataProvider;

	constructor(
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IThemeService private readonly themeService: IThemeService,
		@IVoltVisualPreviewService private readonly preview: IVoltVisualPreviewService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.webviewTheme = this._register(instantiationService.createInstance(WebviewThemeDataProvider));
	}

	async publish(html: string, title: string, options: { readonly cap?: number; readonly screenshot?: boolean } = {}): Promise<IPublishedPage> {
		const ref = await this.history.putAttachment(VSBuffer.fromString(html).buffer, 'text/html');
		let height: number | undefined;
		let heights: [number, number][] | undefined;
		let errors: string[] = [];
		let png: string | undefined;
		try {
			const measured = await this.preview.capture({
				html: this.previewPage(html),
				width: VISUAL_COLUMN_WIDTH,
				measureOnly: !options.screenshot,
				measureWidths: PAGE_MEASURE_WIDTHS.filter(width => width !== VISUAL_COLUMN_WIDTH),
				...(options.screenshot ? { background: this.previewBackground() } : {}),
			});
			height = measured.contentHeight;
			heights = [[VISUAL_COLUMN_WIDTH, measured.contentHeight] as [number, number], ...measured.heights.map(([width, h]) => [width, h] as [number, number])].sort((a, b) => a[0] - b[0]);
			errors = measured.console.filter(message => message.level === 'error').map(message => message.text);
			png = measured.png;
		} catch (err) {
			this.logService.warn('[volt] could not measure a visual page', err);
			errors = [err instanceof Error ? err.message : String(err)];
		}
		const cap = options.cap !== undefined && Number.isFinite(options.cap) ? Math.max(VISUAL_MIN_HEIGHT, Math.min(VISUAL_MAX_HEIGHT, options.cap)) : undefined;
		const shown = Math.max(VISUAL_MIN_HEIGHT, Math.min(cap ?? VISUAL_MAX_HEIGHT, height ?? cap ?? 480));
		return {
			visual: { kind: 'html', ref, title, height: shown, ...(heights?.length ? { heights } : {}), ...(cap ? { cap } : {}) },
			errors,
			...(png ? { png } : {}),
		};
	}

	/** The page as an offscreen window sees it: every `--vscode-*` color inlined (no webview to inject them), animations off. */
	previewPage(html: string): string {
		const theme = this.themeService.getColorTheme();
		const styles = this.webviewTheme.getWebviewThemeData().styles;
		const vscode: Record<string, string> = {};
		for (const [key, value] of Object.entries(styles)) {
			vscode[`--${key}`] = String(value);
		}
		return buildVisualPage(html, { themeCss: visualThemeCss(theme, vscode), kind: themeKind(theme), preview: true });
	}

	/** What the page sits on in the chat (`--background`), made opaque for the screenshot. */
	previewBackground(): { r: number; g: number; b: number } {
		const theme = this.themeService.getColorTheme();
		const fallback = Color.fromHex(themeKind(theme) === 'light' ? '#ffffff' : '#1e1e1e');
		const editor = theme.getColor('editor.background')?.makeOpaque(fallback) ?? fallback;
		const { r, g, b } = (theme.getColor('sideBar.background') ?? editor).makeOpaque(editor).rgba;
		return { r, g, b };
	}

	/** Light or dark, from the user's theme. */
	themeKind(): 'light' | 'dark' {
		return themeKind(this.themeService.getColorTheme());
	}
}
