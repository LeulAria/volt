/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/canvasScratchPage.css';
import { $ } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import {
	CANVAS_ENABLED_SETTING, CANVAS_FRAME_THEME_SETTING, CANVAS_OPEN_BESIDE_SETTING, CanvasFrameTheme, readCanvasFrameTheme, readNewBoardSettings, readSnapshotMinutes, readTrashDays,
	SCRATCH_AGENT_TOOLS_SETTING, SCRATCH_ENABLED_SETTING, SCRATCH_HIDE_CHATS_SETTING, SCRATCH_HIGHLIGHT_CONNECTIONS_SETTING, SCRATCH_NEW_BACKGROUND_SETTING, SCRATCH_NEW_GRID_SETTING, SCRATCH_NEW_SNAP_GRID_SETTING,
	SCRATCH_NEW_SNAP_OBJECTS_SETTING, SCRATCH_NEW_THEME_SETTING, SCRATCH_SNAPSHOT_MINUTES, SCRATCH_SNAPSHOT_MINUTES_SETTING, SCRATCH_TRASH_DAYS, SCRATCH_TRASH_DAYS_SETTING,
} from '../../voltAgent/common/canvasScratchSettings.js';
import { IScratchStyleDefaults, SCRATCH_BACKGROUNDS, SCRATCH_FONT_SIZES, SCRATCH_STROKE_COLORS, SCRATCH_STROKE_WIDTHS, ScratchArrowType, ScratchFontFamily, ScratchGrid, ScratchTheme } from '../../voltAgent/common/scratchBoard/scratchTypes.js';
import { readScratchStyle, writeScratchStyle } from '../../voltAgent/browser/scratchBoard/scratchCanvasState.js';
import { NEW_SCRATCH_BOARD_COMMAND_ID, OPEN_SCRATCH_BOARD_COMMAND_ID } from '../../voltAgent/browser/scratchBoard/scratchBoardInput.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { IVoltDropdownOption } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { ISettingsPageKit } from './codeIntelligencePage.js';

/** The settings editor's blocks, plus the Volt dropdown and a section hint. */
export interface ICanvasScratchPageKit extends ISettingsPageKit {
	dropdown<T extends string>(parent: HTMLElement, options: readonly IVoltDropdownOption<T>[], value: T, label: string, onChange: (value: T) => void): void;
	sectionHint(text: string): void;
}

/** A round colour chip for a dropdown option. */
function swatch(color: string): () => HTMLElement {
	return () => {
		const chip = $('span.volt-settings-swatch');
		chip.style.background = color;
		return chip;
	};
}

const BACKGROUND_NAMES: Record<typeof SCRATCH_BACKGROUNDS[number], string> = {
	'#ffffff': localize('voltCanvasScratch.bgWhite', "White"),
	'#f8f9fa': localize('voltCanvasScratch.bgPaper', "Paper"),
	'#f5faff': localize('voltCanvasScratch.bgSky', "Sky"),
	'#fffce8': localize('voltCanvasScratch.bgCream', "Cream"),
	'#fdf8f6': localize('voltCanvasScratch.bgBlush', "Blush"),
	'#f3f0ff': localize('voltCanvasScratch.bgLavender', "Lavender"),
	'#ebfbee': localize('voltCanvasScratch.bgMint', "Mint"),
};

const STROKE_NAMES: Record<typeof SCRATCH_STROKE_COLORS[number], string> = {
	'#1e1e1e': localize('voltCanvasScratch.inkBlack', "Ink"),
	'#e03131': localize('voltCanvasScratch.inkRed', "Red"),
	'#2f9e44': localize('voltCanvasScratch.inkGreen', "Green"),
	'#1971c2': localize('voltCanvasScratch.inkBlue', "Blue"),
	'#f08c00': localize('voltCanvasScratch.inkOrange', "Orange"),
	'#9c36b5': localize('voltCanvasScratch.inkViolet', "Violet"),
	'#0c8599': localize('voltCanvasScratch.inkTeal', "Teal"),
	'#846358': localize('voltCanvasScratch.inkBrown', "Brown"),
};

/**
 * Settings > Canvas & Scratch: whether Scratch (the whiteboard) and the agents' design canvas are
 * on, what new boards start with, the style new elements are drawn with, how long versions and
 * deleted boards are kept, and how canvases open.
 */
export class CanvasScratchPage {

	constructor(
		private readonly kit: ICanvasScratchPageKit,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
	) { }

	private update(key: string, value: unknown): void {
		void this.configurationService.updateValue(key, value).then(() => this.kit.rerender());
	}

	private switchRow(parent: HTMLElement, key: string, title: string, desc: string, fallback = true): void {
		const value = this.configurationService.getValue<boolean>(key);
		const on = typeof value === 'boolean' ? value : fallback;
		this.kit.settingRow(parent, title, desc, host => this.kit.toggle(host, on, title, () => this.update(key, !on)));
	}

	private choiceRow<T extends string>(parent: HTMLElement, title: string, desc: string, options: readonly IVoltDropdownOption<T>[], value: T, onChange: (value: T) => void): void {
		this.kit.settingRow(parent, title, desc, host => this.kit.dropdown(host, options, value, title, onChange));
	}

	private setStyle(patch: Partial<IScratchStyleDefaults> | undefined): void {
		writeScratchStyle(this.storageService, patch);
		this.kit.rerender();
	}

	render(): void {
		const kit = this.kit;
		kit.pageHead(
			localize('voltCanvasScratch.title', "Canvas & Scratch"),
			localize('voltCanvasScratch.lead', "Scratch is your whiteboard beside the chats, where agents can draw diagrams back. The design canvas is the board of live screens agents show for UI work."),
		);
		this.renderScratch();
		this.renderNewBoards();
		this.renderDrawingStyle();
		this.renderHistory();
		this.renderCanvas();
	}

	private renderScratch(): void {
		const kit = this.kit;
		kit.sectionLabel(localize('voltCanvasScratch.scratch', "Scratch"));
		const group = kit.settingsGroup();
		this.switchRow(group, SCRATCH_ENABLED_SETTING,
			localize('voltCanvasScratch.enabled', "Scratch"),
			localize('voltCanvasScratch.enabledDesc', "Show the Scratch button in the home bar and the sidebar rail. Off, Scratch and its agent tools are hidden; your boards stay on disk."));
		this.switchRow(group, SCRATCH_AGENT_TOOLS_SETTING,
			localize('voltCanvasScratch.agentTools', "Agents Draw on Boards"),
			localize('voltCanvasScratch.agentToolsDesc', "Let agents read a board and answer with flowcharts, sticky notes and cards drawn on it"));
		this.switchRow(group, SCRATCH_HIDE_CHATS_SETTING,
			localize('voltCanvasScratch.hideChats', "Full-Page Boards"),
			localize('voltCanvasScratch.hideChatsDesc', "Put the chats list away while Scratch is open and bring it back when you leave"));
		this.switchRow(group, SCRATCH_HIGHLIGHT_CONNECTIONS_SETTING,
			localize('voltCanvasScratch.highlightConnections', "Highlight Connections"),
			localize('voltCanvasScratch.highlightConnectionsDesc', "Hover a shape to light up the connectors joined to it and fade the rest; hover a connector to see what it joins"));
		kit.settingRow(group,
			localize('voltCanvasScratch.boards', "Boards"),
			localize('voltCanvasScratch.boardsDesc', "Open Scratch on your last board, or start a new one"),
			host => {
				const open = kit.store.add(createVoltButton(host, 'secondary'));
				open.label = localize('voltCanvasScratch.open', "Open Scratch");
				kit.store.add(open.onDidClick(() => void this.commandService.executeCommand(OPEN_SCRATCH_BOARD_COMMAND_ID)));
				const create = kit.store.add(createVoltButton(host, 'secondary'));
				create.label = localize('voltCanvasScratch.newBoard', "New Board");
				kit.store.add(create.onDidClick(() => void this.commandService.executeCommand(NEW_SCRATCH_BOARD_COMMAND_ID)));
			});
	}

	private renderNewBoards(): void {
		const kit = this.kit;
		kit.sectionLabel(localize('voltCanvasScratch.newBoards', "New Boards"));
		kit.sectionHint(localize('voltCanvasScratch.newBoardsHint', "What a new board starts with. Each board keeps its own settings after that, in its menu."));
		const group = kit.settingsGroup();
		const settings = readNewBoardSettings(key => this.configurationService.getValue(key));
		const themes: IVoltDropdownOption<ScratchTheme>[] = [
			{ id: 'auto', label: localize('voltCanvasScratch.themeAuto', "Follow Volt"), description: localize('voltCanvasScratch.themeAutoDesc', "Light or dark with the Volt theme") },
			{ id: 'light', label: localize('voltCanvasScratch.themeLight', "Light") },
			{ id: 'dark', label: localize('voltCanvasScratch.themeDark', "Dark") },
		];
		this.choiceRow(group, localize('voltCanvasScratch.theme', "Board Theme"),
			localize('voltCanvasScratch.themeDesc', "Dark boards invert their colours, the way Excalidraw does"),
			themes, settings.theme, id => this.update(SCRATCH_NEW_THEME_SETTING, id));
		const grids: IVoltDropdownOption<ScratchGrid>[] = [
			{ id: 'dots', label: localize('voltCanvasScratch.gridDots', "Dots") },
			{ id: 'lines', label: localize('voltCanvasScratch.gridLines', "Lines") },
			{ id: 'none', label: localize('voltCanvasScratch.gridNone', "None") },
		];
		this.choiceRow(group, localize('voltCanvasScratch.grid', "Grid"),
			localize('voltCanvasScratch.gridDesc', "The pattern behind the board"),
			grids, settings.grid, id => this.update(SCRATCH_NEW_GRID_SETTING, id));
		const backgrounds = SCRATCH_BACKGROUNDS.map(color => ({ id: color, label: BACKGROUND_NAMES[color], icon: swatch(color) }));
		this.choiceRow(group, localize('voltCanvasScratch.background', "Background"),
			localize('voltCanvasScratch.backgroundDesc', "The board's paper colour"),
			backgrounds, settings.background as typeof SCRATCH_BACKGROUNDS[number], id => this.update(SCRATCH_NEW_BACKGROUND_SETTING, id));
		this.switchRow(group, SCRATCH_NEW_SNAP_OBJECTS_SETTING,
			localize('voltCanvasScratch.snapObjects', "Snap to Objects"),
			localize('voltCanvasScratch.snapObjectsDesc', "Line up moved elements with the edges and centres of the others"), settings.snapToObjects);
		this.switchRow(group, SCRATCH_NEW_SNAP_GRID_SETTING,
			localize('voltCanvasScratch.snapGrid', "Snap to Grid"),
			localize('voltCanvasScratch.snapGridDesc', "Move and draw on the grid's steps"), settings.snapToGrid);
	}

	private renderDrawingStyle(): void {
		const kit = this.kit;
		kit.sectionLabel(localize('voltCanvasScratch.drawingStyle', "Drawing Style"));
		kit.sectionHint(localize('voltCanvasScratch.drawingStyleHint', "What new shapes, arrows and text are drawn with on every board. The properties bar changes the same style while nothing is selected."));
		const group = kit.settingsGroup();
		const style = readScratchStyle(this.storageService);
		const fonts: IVoltDropdownOption<ScratchFontFamily>[] = [
			{ id: 'hand', label: localize('voltCanvasScratch.fontHand', "Hand-drawn") },
			{ id: 'sans', label: localize('voltCanvasScratch.fontSans', "Sans") },
			{ id: 'serif', label: localize('voltCanvasScratch.fontSerif', "Serif") },
			{ id: 'mono', label: localize('voltCanvasScratch.fontMono', "Code") },
		];
		this.choiceRow(group, localize('voltCanvasScratch.font', "Font"),
			localize('voltCanvasScratch.fontDesc', "The typeface of new text, notes and labels"),
			fonts, style.fontFamily, id => this.setStyle({ fontFamily: id }));
		const sizes = (Object.entries(SCRATCH_FONT_SIZES) as [keyof typeof SCRATCH_FONT_SIZES, number][]).map(([name, px]) => ({
			id: String(px),
			label: { small: localize('voltCanvasScratch.sizeSmall', "Small"), medium: localize('voltCanvasScratch.sizeMedium', "Medium"), large: localize('voltCanvasScratch.sizeLarge', "Large"), huge: localize('voltCanvasScratch.sizeHuge', "Huge") }[name],
			description: localize('voltCanvasScratch.sizePx', "{0} px", px),
		}));
		const size = sizes.find(option => Number(option.id) === style.fontSize)?.id ?? String(SCRATCH_FONT_SIZES.medium);
		this.choiceRow(group, localize('voltCanvasScratch.fontSize', "Text Size"),
			localize('voltCanvasScratch.fontSizeDesc', "How large new text starts"),
			sizes, size, id => this.setStyle({ fontSize: Number(id) }));
		const strokes = SCRATCH_STROKE_COLORS.map(color => ({ id: color, label: STROKE_NAMES[color], icon: swatch(color) }));
		const stroke = (SCRATCH_STROKE_COLORS as readonly string[]).includes(style.stroke) ? style.stroke as typeof SCRATCH_STROKE_COLORS[number] : SCRATCH_STROKE_COLORS[0];
		this.choiceRow(group, localize('voltCanvasScratch.stroke', "Stroke Colour"),
			localize('voltCanvasScratch.strokeDesc', "The outline and ink colour"),
			strokes, stroke, id => this.setStyle({ stroke: id }));
		const widths: IVoltDropdownOption<string>[] = [
			{ id: String(SCRATCH_STROKE_WIDTHS.thin), label: localize('voltCanvasScratch.widthThin', "Thin") },
			{ id: String(SCRATCH_STROKE_WIDTHS.bold), label: localize('voltCanvasScratch.widthBold', "Bold") },
			{ id: String(SCRATCH_STROKE_WIDTHS.extraBold), label: localize('voltCanvasScratch.widthExtraBold', "Extra Bold") },
		];
		const width = widths.find(option => Number(option.id) === style.strokeWidth)?.id ?? String(SCRATCH_STROKE_WIDTHS.bold);
		this.choiceRow(group, localize('voltCanvasScratch.strokeWidth', "Stroke Width"),
			localize('voltCanvasScratch.strokeWidthDesc', "How heavy outlines and lines are"),
			widths, width, id => this.setStyle({ strokeWidth: Number(id) }));
		const sloppiness: IVoltDropdownOption<string>[] = [
			{ id: '0', label: localize('voltCanvasScratch.roughArchitect', "Architect"), description: localize('voltCanvasScratch.roughArchitectDesc', "Clean, straight lines") },
			{ id: '1', label: localize('voltCanvasScratch.roughArtist', "Artist"), description: localize('voltCanvasScratch.roughArtistDesc', "A light hand-drawn wobble") },
			{ id: '2', label: localize('voltCanvasScratch.roughCartoonist', "Cartoonist"), description: localize('voltCanvasScratch.roughCartoonistDesc', "Loose and sketchy") },
		];
		this.choiceRow(group, localize('voltCanvasScratch.sloppiness', "Sloppiness"),
			localize('voltCanvasScratch.sloppinessDesc', "How hand-drawn shapes look"),
			sloppiness, String(Math.round(style.roughness)), id => this.setStyle({ roughness: Number(id) }));
		const arrows: IVoltDropdownOption<ScratchArrowType>[] = [
			{ id: 'sharp', label: localize('voltCanvasScratch.arrowSharp', "Straight") },
			{ id: 'round', label: localize('voltCanvasScratch.arrowRound', "Curved") },
			{ id: 'elbow', label: localize('voltCanvasScratch.arrowElbow', "Elbow"), description: localize('voltCanvasScratch.arrowElbowDesc', "Right-angled connectors") },
		];
		this.choiceRow(group, localize('voltCanvasScratch.arrowType', "Arrow Type"),
			localize('voltCanvasScratch.arrowTypeDesc', "How new arrows bend between shapes"),
			arrows, style.arrowType, id => this.setStyle({ arrowType: id }));
		kit.settingRow(group,
			localize('voltCanvasScratch.resetStyle', "Reset Style"),
			localize('voltCanvasScratch.resetStyleDesc', "Go back to Volt's drawing style: hand-drawn, bold ink, curved arrows"),
			host => {
				const reset = kit.store.add(createVoltButton(host, 'secondary'));
				reset.label = localize('voltCanvasScratch.reset', "Reset");
				kit.store.add(reset.onDidClick(() => this.setStyle(undefined)));
			});
	}

	private renderHistory(): void {
		const kit = this.kit;
		kit.sectionLabel(localize('voltCanvasScratch.history', "History"));
		const group = kit.settingsGroup();
		const minutes = SCRATCH_SNAPSHOT_MINUTES.map(value => ({
			id: String(value),
			label: value === 0
				? localize('voltCanvasScratch.versionsOff', "Off")
				: value === 60 ? localize('voltCanvasScratch.versionsHour', "Every hour") : localize('voltCanvasScratch.versionsMinutes', "Every {0} minutes", value),
		}));
		this.choiceRow(group, localize('voltCanvasScratch.versions', "Saved Versions"),
			localize('voltCanvasScratch.versionsDesc', "How often a board keeps a version you can go back to while you edit (the newest 40 are kept). The board as you opened it is always kept."),
			minutes, String(readSnapshotMinutes(this.configurationService.getValue(SCRATCH_SNAPSHOT_MINUTES_SETTING))), id => this.update(SCRATCH_SNAPSHOT_MINUTES_SETTING, Number(id)));
		const days = SCRATCH_TRASH_DAYS.map(value => ({
			id: String(value),
			label: value === 365 ? localize('voltCanvasScratch.trashYear', "1 year") : localize('voltCanvasScratch.trashDaysN', "{0} days", value),
		}));
		this.choiceRow(group, localize('voltCanvasScratch.trash', "Keep Deleted Boards"),
			localize('voltCanvasScratch.trashDesc', "How long a deleted board can be brought back before it is removed for good"),
			days, String(readTrashDays(this.configurationService.getValue(SCRATCH_TRASH_DAYS_SETTING))), id => this.update(SCRATCH_TRASH_DAYS_SETTING, Number(id)));
	}

	private renderCanvas(): void {
		const kit = this.kit;
		kit.sectionLabel(localize('voltCanvasScratch.canvas', "Design Canvas"));
		const group = kit.settingsGroup();
		this.switchRow(group, CANVAS_ENABLED_SETTING,
			localize('voltCanvasScratch.canvasEnabled', "Design Canvas"),
			localize('voltCanvasScratch.canvasEnabledDesc', "Let agents show multi-screen designs (flows, phone and desktop sizes, variants) as a board you pan, play and comment on. Off, agents answer with mockups and pages instead; canvases you have keep opening."));
		const looks: IVoltDropdownOption<CanvasFrameTheme>[] = [
			{ id: 'auto', label: localize('voltCanvasScratch.lookAuto', "Follow Volt"), description: localize('voltCanvasScratch.lookAutoDesc', "Light or dark with the Volt theme") },
			{ id: 'light', label: localize('voltCanvasScratch.lookLight', "Light") },
			{ id: 'dark', label: localize('voltCanvasScratch.lookDark', "Dark") },
		];
		this.choiceRow(group, localize('voltCanvasScratch.frameLook', "Frame Look"),
			localize('voltCanvasScratch.frameLookDesc', "The look screens open in when the agent did not fix one"),
			looks, readCanvasFrameTheme(this.configurationService.getValue(CANVAS_FRAME_THEME_SETTING)), id => this.update(CANVAS_FRAME_THEME_SETTING, id));
		this.switchRow(group, CANVAS_OPEN_BESIDE_SETTING,
			localize('voltCanvasScratch.openBeside', "Open Beside the Chat"),
			localize('voltCanvasScratch.openBesideDesc', "Open each new canvas in a tab beside the chat as well as in the reply"), false);
	}
}
