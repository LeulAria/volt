/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, isHTMLElement } from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { isMacintosh } from '../../../../../../base/common/platform.js';
import { localize } from '../../../../../../nls.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IWorkflowNode, IWorkflowNodeType, WORKFLOW_NODE_COLORS, WorkflowNodeColor } from '../../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../../ui/menu/voltMenu.js';
import { colorLabel } from './workflowCanvasNodes.js';
import { swatch } from './workflowCanvasToolbar.js';

const MOD = isMacintosh ? '⌘' : 'Ctrl+';
const SHIFT = isMacintosh ? '⇧' : 'Shift+';

type Run = () => void;

function item(id: string, label: string, run: Run, extra: Partial<IVoltMenuItem<Run>> = {}): IVoltMenuItem<Run> {
	return { id, label, data: run, ...extra };
}

/** What the canvas menus can do; the canvas implements it. */
export interface IWorkflowCanvasMenuHost {
	readonly snapToGrid: boolean;
	readonly showMinimap: boolean;
	addNodeAt(client: { readonly x: number; readonly y: number }): void;
	pasteAt(client: { readonly x: number; readonly y: number } | undefined): void;
	selectAll(): void;
	autoLayout(onlySelection?: boolean): void;
	fitView(animate?: boolean): void;
	toggleSnap(): void;
	toggleMinimap(): void;
	openNode(id: string): void;
	renameNode(id: string): void;
	runNode(id: string): void;
	setColor(ids: readonly string[], color: WorkflowNodeColor | undefined): void;
	duplicate(ids: readonly string[]): void;
	setDisabled(ids: readonly string[], disabled: boolean): void;
	group(ids: readonly string[]): void;
	copy(ids: readonly string[]): void;
	remove(ids: readonly string[]): void;
	insertOnEdge(edgeId: string, client: { readonly x: number; readonly y: number }): void;
	removeEdge(edgeId: string): void;
	renameGroup(groupId: string): void;
	setGroupColor(groupId: string, color: WorkflowNodeColor | undefined): void;
	ungroup(groupId: string): void;
	selectGroup(groupId: string): void;
}

function colorItems(current: WorkflowNodeColor | undefined, autoColor: WorkflowNodeColor | undefined, set: (color: WorkflowNodeColor | undefined) => void): IVoltMenuItem<Run>[] {
	return [
		item('color-auto', localize('voltWorkflows.colorAuto', "Block type's colour"), () => set(undefined), { icon: () => swatch(undefined, autoColor), checked: current === undefined }),
		...WORKFLOW_NODE_COLORS.map(color => item(`color-${color}`, colorLabel(color), () => set(color), { icon: () => swatch(color), checked: current === color })),
	];
}

/** A 1px anchor at the pointer for a menu that opens where the user right-clicked. */
function pointerAnchor(doc: Document, client: { readonly x: number; readonly y: number }): HTMLElement {
	const anchor = $('span.volt-wf-menu-anchor');
	anchor.style.position = 'fixed';
	anchor.style.left = `${client.x}px`;
	anchor.style.top = `${client.y}px`;
	anchor.style.width = '1px';
	anchor.style.height = '1px';
	doc.body.appendChild(anchor);
	return anchor;
}

function show(contextViewService: IContextViewService, anchor: HTMLElement, sections: readonly IVoltMenuSection<Run>[], label: string, onHide?: () => void): void {
	showVoltMenu<Run>(contextViewService, {
		anchor,
		position: 'below',
		align: 'left',
		gap: 4,
		width: 248,
		ariaLabel: label,
		sections,
		onPick: picked => picked.data(),
		onHide,
	});
}

export function showCanvasMenu(contextViewService: IContextViewService, doc: Document, client: { readonly x: number; readonly y: number }, host: IWorkflowCanvasMenuHost, hasSelection: boolean): void {
	const anchor = pointerAnchor(doc, client);
	const sections: IVoltMenuSection<Run>[] = [
		{
			id: 'add', items: [
				item('add', localize('voltWorkflows.addNode', "Add block"), () => host.addNodeAt(client), { icon: Codicon.add, keybinding: 'Tab' }),
				item('paste', localize('voltWorkflows.paste', "Paste"), () => host.pasteAt(client), { icon: Codicon.clippy, keybinding: `${MOD}V` }),
			],
		},
		{
			id: 'arrange', items: [
				item('selectAll', localize('voltWorkflows.selectAll', "Select all"), () => host.selectAll(), { keybinding: `${MOD}A` }),
				item('layout', hasSelection ? localize('voltWorkflows.autoLayoutSelection', "Auto-layout selection") : localize('voltWorkflows.autoLayout', "Auto-layout"), () => host.autoLayout(hasSelection), { icon: Codicon.typeHierarchySub, keybinding: `${SHIFT}${isMacintosh ? '⌥' : 'Alt+'}L` }),
				item('fit', localize('voltWorkflows.fitView', "Fit to view"), () => host.fitView(true), { icon: Codicon.screenFull, keybinding: `${SHIFT}1` }),
			],
		},
		{
			id: 'view', items: [
				item('snap', localize('voltWorkflows.snapToGrid', "Snap to grid"), () => host.toggleSnap(), { checked: host.snapToGrid }),
				item('minimap', localize('voltWorkflows.minimapToggle', "Overview map"), () => host.toggleMinimap(), { checked: host.showMinimap }),
			],
		},
	];
	show(contextViewService, anchor, sections, localize('voltWorkflows.canvasMenu', "Canvas actions"), () => anchor.remove());
}

/** The node menu: at the pointer (`client`) or under a toolbar button (`anchor`). */
export function showNodeMenu(contextViewService: IContextViewService, doc: Document, at: { readonly x: number; readonly y: number } | HTMLElement, host: IWorkflowCanvasMenuHost, node: IWorkflowNode, type: IWorkflowNodeType | undefined, selection: readonly string[]): void {
	const anchor = isHTMLElement(at) ? at : pointerAnchor(doc, at);
	const ids = selection.includes(node.id) && selection.length > 1 ? selection : [node.id];
	const many = ids.length > 1;
	const isStart = type?.control === 'start';
	const disabled = !!node.disabled;
	const sections: IVoltMenuSection<Run>[] = [
		{
			id: 'node', items: [
				item('open', localize('voltWorkflows.openSettings', "Open settings"), () => host.openNode(node.id), { icon: Codicon.gear, keybinding: 'Enter', disabled: many }),
				item('rename', localize('voltWorkflows.rename', "Rename"), () => host.renameNode(node.id), { icon: Codicon.edit, keybinding: 'F2', disabled: many }),
				...(type?.control === 'task' ? [item('run', localize('voltWorkflows.runStep', "Run this step"), () => host.runNode(node.id), { icon: Codicon.play, disabled: many })] : []),
			],
		},
		{
			id: 'style', items: [
				item('color', localize('voltWorkflows.color', "Colour"), () => undefined, { icon: () => swatch(node.color, type?.color), submenu: { width: 200, sections: [{ id: 'colors', items: colorItems(many ? undefined : node.color, type?.color, color => host.setColor(ids, color)) }] } }),
				...(!isStart ? [
					item('duplicate', localize('voltWorkflows.duplicate', "Duplicate"), () => host.duplicate(ids), { icon: Codicon.copy, keybinding: `${MOD}D` }),
					item('disable', disabled ? localize('voltWorkflows.enable', "Enable") : localize('voltWorkflows.disable', "Disable"), () => host.setDisabled(ids, !disabled), { icon: disabled ? Codicon.eye : Codicon.circleSlash }),
				] : []),
				item('group', many ? localize('voltWorkflows.groupSelection', "Group selection") : localize('voltWorkflows.groupNode', "Put in a group"), () => host.group(ids), { icon: Codicon.groupByRefType, keybinding: `${MOD}G` }),
			],
		},
		{
			id: 'edit', items: [
				item('copy', localize('voltWorkflows.copyYaml', "Copy as YAML"), () => host.copy(ids), { icon: Codicon.copy, keybinding: `${MOD}C` }),
				...(!isStart || many ? [item('delete', many ? localize('voltWorkflows.deleteNodes', "Delete {0} blocks", ids.length) : localize('voltWorkflows.delete', "Delete"), () => host.remove(ids), { icon: Codicon.trash, keybinding: isMacintosh ? '\u232B' : 'Del' })] : []),
			],
		},
	];
	const onHide = isHTMLElement(at) ? undefined : () => anchor.remove();
	show(contextViewService, anchor, sections, localize('voltWorkflows.nodeMenu', "Block actions"), onHide);
}

export function showEdgeMenu(contextViewService: IContextViewService, doc: Document, client: { readonly x: number; readonly y: number }, host: IWorkflowCanvasMenuHost, edgeId: string): void {
	const anchor = pointerAnchor(doc, client);
	const sections: IVoltMenuSection<Run>[] = [{
		id: 'edge', items: [
			item('insert', localize('voltWorkflows.insertBlock', "Insert a block"), () => host.insertOnEdge(edgeId, client), { icon: Codicon.add }),
			item('delete', localize('voltWorkflows.deleteConnection', "Delete connection"), () => host.removeEdge(edgeId), { icon: Codicon.trash, keybinding: isMacintosh ? '\u232B' : 'Del' }),
		],
	}];
	show(contextViewService, anchor, sections, localize('voltWorkflows.edgeMenu', "Connection actions"), () => anchor.remove());
}

export function showGroupMenu(contextViewService: IContextViewService, doc: Document, client: { readonly x: number; readonly y: number }, host: IWorkflowCanvasMenuHost, groupId: string, color: WorkflowNodeColor | undefined): void {
	const anchor = pointerAnchor(doc, client);
	const sections: IVoltMenuSection<Run>[] = [{
		id: 'group', items: [
			item('select', localize('voltWorkflows.selectGroup', "Select blocks"), () => host.selectGroup(groupId)),
			item('rename', localize('voltWorkflows.renameGroup', "Rename group"), () => host.renameGroup(groupId), { icon: Codicon.edit }),
			item('color', localize('voltWorkflows.color', "Colour"), () => undefined, { icon: () => swatch(color), submenu: { width: 200, sections: [{ id: 'colors', items: colorItems(color, 'default', next => host.setGroupColor(groupId, next)) }] } }),
			item('ungroup', localize('voltWorkflows.ungroup', "Ungroup"), () => host.ungroup(groupId), { icon: Codicon.close, keybinding: `${SHIFT}${MOD}G` }),
		],
	}];
	show(contextViewService, anchor, sections, localize('voltWorkflows.groupMenu', "Group actions"), () => anchor.remove());
}
