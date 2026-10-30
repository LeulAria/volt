/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { deepClone } from '../../../../base/common/objects.js';
import { badgeBackground, buttonForeground, chartsBlue, chartsPurple, foreground } from '../../../../platform/theme/common/colorRegistry.js';
import { asCssVariable, ColorIdentifier, registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { ISCMHistoryItem, ISCMHistoryItemGraphNode, ISCMHistoryItemRef, ISCMHistoryItemViewModel } from '../common/history.js';
import { rot } from '../../../../base/common/numbers.js';
import { svgElem } from '../../../../base/browser/dom.js';

export const SWIMLANE_HEIGHT = 22;
export const SWIMLANE_WIDTH = 11;
const SWIMLANE_CURVE_RADIUS = 5;
const CIRCLE_RADIUS = 4;
const CIRCLE_STROKE_WIDTH = 2;

/**
 * History item reference colors (local, remote, base)
 */
export const historyItemRefColor = registerColor('scmGraph.historyItemRefColor', chartsBlue, localize('scmGraphHistoryItemRefColor', "History item reference color."));
export const historyItemRemoteRefColor = registerColor('scmGraph.historyItemRemoteRefColor', chartsPurple, localize('scmGraphHistoryItemRemoteRefColor', "History item remote reference color."));
export const historyItemBaseRefColor = registerColor('scmGraph.historyItemBaseRefColor', '#EA5C00', localize('scmGraphHistoryItemBaseRefColor', "History item base reference color."));

/**
 * History item hover color
 */
export const historyItemHoverDefaultLabelForeground = registerColor('scmGraph.historyItemHoverDefaultLabelForeground', foreground, localize('scmGraphHistoryItemHoverDefaultLabelForeground', "History item hover default label foreground color."));
export const historyItemHoverDefaultLabelBackground = registerColor('scmGraph.historyItemHoverDefaultLabelBackground', badgeBackground, localize('scmGraphHistoryItemHoverDefaultLabelBackground', "History item hover default label background color."));
export const historyItemHoverLabelForeground = registerColor('scmGraph.historyItemHoverLabelForeground', buttonForeground, localize('scmGraphHistoryItemHoverLabelForeground', "History item hover label foreground color."));
export const historyItemHoverAdditionsForeground = registerColor('scmGraph.historyItemHoverAdditionsForeground', { light: '#587C0C', dark: '#81B88B', hcDark: '#A1E3AD', hcLight: '#374E06' }, localize('scmGraph.HistoryItemHoverAdditionsForeground', "History item hover additions foreground color."));
export const historyItemHoverDeletionsForeground = registerColor('scmGraph.historyItemHoverDeletionsForeground', { light: '#AD0707', dark: '#C74E39', hcDark: '#C74E39', hcLight: '#AD0707' }, localize('scmGraph.HistoryItemHoverDeletionsForeground', "History item hover deletions foreground color."));

/**
 * History graph color registry
 */
export const colorRegistry: ColorIdentifier[] = [
	registerColor('scmGraph.foreground1', '#FFB000', localize('scmGraphForeground1', "Source control graph foreground color (1).")),
	registerColor('scmGraph.foreground2', '#DC267F', localize('scmGraphForeground2', "Source control graph foreground color (2).")),
	registerColor('scmGraph.foreground3', '#994F00', localize('scmGraphForeground3', "Source control graph foreground color (3).")),
	registerColor('scmGraph.foreground4', '#40B0A6', localize('scmGraphForeground4', "Source control graph foreground color (4).")),
	registerColor('scmGraph.foreground5', '#B66DFF', localize('scmGraphForeground5', "Source control graph foreground color (5).")),
];

function getLabelColorIdentifier(historyItem: ISCMHistoryItem, colorMap: Map<string, ColorIdentifier | undefined>): ColorIdentifier | undefined {
	for (const ref of historyItem.references ?? []) {
		const colorIdentifier = colorMap.get(ref.id);
		if (colorIdentifier !== undefined) {
			return colorIdentifier;
		}
	}

	return undefined;
}

/**
 * Sizes for drawing a row of the graph. The SCM view uses the defaults; bigger surfaces (the Git
 * Graph tab) pass taller rows and wider lanes and get the same drawing scaled to them.
 */
export interface ISCMHistoryGraphGeometry {
	readonly rowHeight: number;
	readonly laneWidth: number;
	readonly curveRadius: number;
	readonly circleRadius: number;
	readonly circleStrokeWidth: number;
	readonly lineWidth: number;
}

export const DEFAULT_SCM_HISTORY_GRAPH_GEOMETRY: ISCMHistoryGraphGeometry = {
	rowHeight: SWIMLANE_HEIGHT,
	laneWidth: SWIMLANE_WIDTH,
	curveRadius: SWIMLANE_CURVE_RADIUS,
	circleRadius: CIRCLE_RADIUS,
	circleStrokeWidth: CIRCLE_STROKE_WIDTH,
	lineWidth: 1,
};

function createPath(colorIdentifier: string, strokeWidth = 1): SVGPathElement {
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('fill', 'none');
	path.setAttribute('stroke-width', `${strokeWidth}px`);
	path.setAttribute('stroke-linecap', 'round');
	path.style.stroke = asCssVariable(colorIdentifier);

	return path;
}

function drawCircle(index: number, radius: number, strokeWidth: number, colorIdentifier: string | undefined, g: ISCMHistoryGraphGeometry = DEFAULT_SCM_HISTORY_GRAPH_GEOMETRY): SVGCircleElement {
	const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
	circle.setAttribute('cx', `${g.laneWidth * (index + 1)}`);
	circle.setAttribute('cy', `${g.rowHeight / 2}`);
	circle.setAttribute('r', `${radius}`);

	circle.style.strokeWidth = `${strokeWidth}px`;
	if (colorIdentifier) {
		circle.style.fill = asCssVariable(colorIdentifier);
	}

	return circle;
}

function drawVerticalLine(x1: number, y1: number, y2: number, color: string, strokeWidth = 1): SVGPathElement {
	const path = createPath(color, strokeWidth);
	path.setAttribute('d', `M ${x1} ${y1} V ${y2}`);

	return path;
}

function findLastIndex(nodes: ISCMHistoryItemGraphNode[], id: string): number {
	for (let i = nodes.length - 1; i >= 0; i--) {
		if (nodes[i].id === id) {
			return i;
		}
	}

	return -1;
}

export function renderSCMHistoryItemGraph(historyItemViewModel: ISCMHistoryItemViewModel, g: ISCMHistoryGraphGeometry = DEFAULT_SCM_HISTORY_GRAPH_GEOMETRY): SVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.classList.add('graph');

	const W = g.laneWidth;
	const H = g.rowHeight;
	const R = g.curveRadius;
	const historyItem = historyItemViewModel.historyItem;
	const inputSwimlanes = historyItemViewModel.inputSwimlanes;
	const outputSwimlanes = historyItemViewModel.outputSwimlanes;

	// Find the history item in the input swimlanes
	const inputIndex = inputSwimlanes.findIndex(node => node.id === historyItem.id);

	// Circle index - use the input swimlane index if present, otherwise add it to the end
	const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;

	// Circle color - use the output swimlane color if present, otherwise the input swimlane color
	const circleColor = circleIndex < outputSwimlanes.length ? outputSwimlanes[circleIndex].color :
		circleIndex < inputSwimlanes.length ? inputSwimlanes[circleIndex].color : historyItemRefColor;

	let outputSwimlaneIndex = 0;
	for (let index = 0; index < inputSwimlanes.length; index++) {
		const color = inputSwimlanes[index].color;

		// Current commit
		if (inputSwimlanes[index].id === historyItem.id) {
			// Base commit
			if (index !== circleIndex) {
				const d: string[] = [];
				const path = createPath(color, g.lineWidth);

				// Draw /
				d.push(`M ${W * (index + 1)} 0`);
				d.push(`A ${W} ${H / 2} 0 0 1 ${W * (index)} ${H / 2}`);

				// Draw -
				d.push(`H ${W * (circleIndex + 1)}`);

				path.setAttribute('d', d.join(' '));
				svg.append(path);
			} else {
				outputSwimlaneIndex++;
			}
		} else {
			// Not the current commit
			if (outputSwimlaneIndex < outputSwimlanes.length &&
				inputSwimlanes[index].id === outputSwimlanes[outputSwimlaneIndex].id) {
				if (index === outputSwimlaneIndex) {
					// Draw |
					const path = drawVerticalLine(W * (index + 1), 0, H, color, g.lineWidth);
					svg.append(path);
				} else {
					const d: string[] = [];
					const path = createPath(color, g.lineWidth);

					// Draw |
					d.push(`M ${W * (index + 1)} 0`);
					d.push(`V ${H / 2 - R}`);

					// Draw /
					d.push(`A ${R} ${R} 0 0 1 ${(W * (index + 1)) - R} ${H / 2}`);

					// Draw -
					d.push(`H ${(W * (outputSwimlaneIndex + 1)) + R}`);

					// Draw /
					d.push(`A ${R} ${R} 0 0 0 ${W * (outputSwimlaneIndex + 1)} ${(H / 2) + R}`);

					// Draw |
					d.push(`V ${H}`);

					path.setAttribute('d', d.join(' '));
					svg.append(path);
				}

				outputSwimlaneIndex++;
			}
		}
	}

	// Add remaining parent(s)
	for (let i = 1; i < historyItem.parentIds.length; i++) {
		const parentOutputIndex = findLastIndex(outputSwimlanes, historyItem.parentIds[i]);
		if (parentOutputIndex === -1) {
			continue;
		}

		// Draw -\
		const d: string[] = [];
		const path = createPath(outputSwimlanes[parentOutputIndex].color, g.lineWidth);

		// Draw \
		d.push(`M ${W * parentOutputIndex} ${H / 2}`);
		d.push(`A ${W} ${H / 2} 0 0 1 ${W * (parentOutputIndex + 1)} ${H}`);

		// Draw -
		d.push(`M ${W * parentOutputIndex} ${H / 2}`);
		d.push(`H ${W * (circleIndex + 1)} `);

		path.setAttribute('d', d.join(' '));
		svg.append(path);
	}

	// Draw | to *
	if (inputIndex !== -1) {
		const path = drawVerticalLine(W * (circleIndex + 1), 0, H / 2, inputSwimlanes[inputIndex].color, g.lineWidth);
		svg.append(path);
	}

	// Draw | from *
	if (historyItem.parentIds.length > 0) {
		const path = drawVerticalLine(W * (circleIndex + 1), H / 2, H, circleColor, g.lineWidth);
		svg.append(path);
	}

	// Draw *
	const radius = g.circleRadius;
	const stroke = g.circleStrokeWidth;
	if (historyItemViewModel.isCurrent) {
		// HEAD
		const outerCircle = drawCircle(circleIndex, radius + 3, stroke, circleColor, g);
		svg.append(outerCircle);

		const innerCircle = drawCircle(circleIndex, stroke, radius, undefined, g);
		svg.append(innerCircle);
	} else {
		if (historyItem.parentIds.length > 1) {
			// Multi-parent node
			const circleOuter = drawCircle(circleIndex, radius + 2, stroke, circleColor, g);
			svg.append(circleOuter);

			const circleInner = drawCircle(circleIndex, radius - 1, stroke, circleColor, g);
			svg.append(circleInner);
		} else {
			// Node
			const circle = drawCircle(circleIndex, radius + 1, stroke, circleColor, g);
			svg.append(circle);
		}
	}

	// Set dimensions
	svg.style.height = `${H}px`;
	svg.style.width = `${W * (Math.max(inputSwimlanes.length, outputSwimlanes.length, 1) + 1)}px`;

	return svg;
}

export function renderSCMHistoryGraphPlaceholder(columns: ISCMHistoryItemGraphNode[], highlightIndex?: number): HTMLElement {
	const elements = svgElem('svg', {
		style: { height: `${SWIMLANE_HEIGHT}px`, width: `${SWIMLANE_WIDTH * (columns.length + 1)}px`, }
	});

	// Draw |
	for (let index = 0; index < columns.length; index++) {
		const strokeWidth = index === highlightIndex ? 3 : 1;
		const path = drawVerticalLine(SWIMLANE_WIDTH * (index + 1), 0, SWIMLANE_HEIGHT, columns[index].color, strokeWidth);
		elements.root.append(path);
	}

	return elements.root;
}

export function toISCMHistoryItemViewModelArray(
	historyItems: ISCMHistoryItem[],
	colorMap = new Map<string, ColorIdentifier | undefined>(),
	currentHistoryItemRef?: ISCMHistoryItemRef,
	currentHistoryItemRemoteRef?: ISCMHistoryItemRef,
	currentHistoryItemBaseRef?: ISCMHistoryItemRef
): ISCMHistoryItemViewModel[] {
	let colorIndex = -1;
	const viewModels: ISCMHistoryItemViewModel[] = [];

	for (let index = 0; index < historyItems.length; index++) {
		const historyItem = historyItems[index];

		const isCurrent = historyItem.id === currentHistoryItemRef?.revision;
		const outputSwimlanesFromPreviousItem = viewModels.at(-1)?.outputSwimlanes ?? [];
		const inputSwimlanes = outputSwimlanesFromPreviousItem.map(i => deepClone(i));
		const outputSwimlanes: ISCMHistoryItemGraphNode[] = [];

		let firstParentAdded = false;

		// Add first parent to the output
		if (historyItem.parentIds.length > 0) {
			for (const node of inputSwimlanes) {
				if (node.id === historyItem.id) {
					if (!firstParentAdded) {
						outputSwimlanes.push({
							id: historyItem.parentIds[0],
							color: getLabelColorIdentifier(historyItem, colorMap) ?? node.color
						});
						firstParentAdded = true;
					}

					continue;
				}

				outputSwimlanes.push(deepClone(node));
			}
		}

		// Add unprocessed parent(s) to the output
		for (let i = firstParentAdded ? 1 : 0; i < historyItem.parentIds.length; i++) {
			// Color index (label -> next color)
			let colorIdentifier: string | undefined;

			if (i === 0) {
				colorIdentifier = getLabelColorIdentifier(historyItem, colorMap);
			} else {
				const historyItemParent = historyItems
					.find(h => h.id === historyItem.parentIds[i]);
				colorIdentifier = historyItemParent ? getLabelColorIdentifier(historyItemParent, colorMap) : undefined;
			}

			if (!colorIdentifier) {
				colorIndex = rot(colorIndex + 1, colorRegistry.length);
				colorIdentifier = colorRegistry[colorIndex];
			}

			outputSwimlanes.push({
				id: historyItem.parentIds[i],
				color: colorIdentifier
			});
		}

		// Add colors to references
		const references = (historyItem.references ?? [])
			.map(ref => {
				let color = colorMap.get(ref.id);
				if (colorMap.has(ref.id) && color === undefined) {
					// Find the history item in the input swimlanes
					const inputIndex = inputSwimlanes.findIndex(node => node.id === historyItem.id);

					// Circle index - use the input swimlane index if present, otherwise add it to the end
					const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;

					// Circle color - use the output swimlane color if present, otherwise the input swimlane color
					color = circleIndex < outputSwimlanes.length ? outputSwimlanes[circleIndex].color :
						circleIndex < inputSwimlanes.length ? inputSwimlanes[circleIndex].color : historyItemRefColor;
				}

				return { ...ref, color };
			});

		// Sort references
		references.sort((ref1, ref2) =>
			compareHistoryItemRefs(ref1, ref2, currentHistoryItemRef, currentHistoryItemRemoteRef, currentHistoryItemBaseRef));

		viewModels.push({
			historyItem: {
				...historyItem,
				references
			},
			isCurrent,
			inputSwimlanes,
			outputSwimlanes,
		});
	}

	return viewModels;
}

export function getHistoryItemIndex(historyItemViewModel: ISCMHistoryItemViewModel): number {
	const historyItem = historyItemViewModel.historyItem;
	const inputSwimlanes = historyItemViewModel.inputSwimlanes;

	// Find the history item in the input swimlanes
	const inputIndex = inputSwimlanes.findIndex(node => node.id === historyItem.id);

	// Circle index - use the input swimlane index if present, otherwise add it to the end
	return inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
}

export function compareHistoryItemRefs(
	ref1: ISCMHistoryItemRef,
	ref2: ISCMHistoryItemRef,
	currentHistoryItemRef?: ISCMHistoryItemRef,
	currentHistoryItemRemoteRef?: ISCMHistoryItemRef,
	currentHistoryItemBaseRef?: ISCMHistoryItemRef
): number {
	const getHistoryItemRefOrder = (ref: ISCMHistoryItemRef) => {
		if (ref.id === currentHistoryItemRef?.id) {
			return 1;
		} else if (ref.id === currentHistoryItemRemoteRef?.id) {
			return 2;
		} else if (ref.id === currentHistoryItemBaseRef?.id) {
			return 3;
		} else if (ref.color !== undefined) {
			return 4;
		}

		return 99;
	};

	// Assign order (current > remote > base > color)
	const ref1Order = getHistoryItemRefOrder(ref1);
	const ref2Order = getHistoryItemRefOrder(ref2);

	return ref1Order - ref2Order;
}
