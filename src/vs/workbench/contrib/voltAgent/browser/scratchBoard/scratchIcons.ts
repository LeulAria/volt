/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Scratch's icons, built as SVG nodes (the window's Trusted Types policy forbids parsing SVG
 * text). Most are Lucide (ISC licence, via Aria Icons); the system design blocks are Tabler (MIT,
 * via Aria Icons), which has purpose-made infrastructure glyphs; the property swatches at the end
 * are drawn for Scratch, after Excalidraw's.
 */

import { localize } from '../../../../../nls.js';
import { ScratchShapeKind } from '../../common/scratchBoard/scratchTypes.js';

type IconAttrs = Readonly<Record<string, string>>;
type IconNode = readonly [string, IconAttrs];

const LUCIDE: Readonly<Record<string, readonly IconNode[]>> = {
	'activity': [['path', { d: 'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2' }]],
	'align-center-horizontal': [['path', { d: 'M2 12h20' }], ['path', { d: 'M10 16v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4' }], ['path', { d: 'M10 8V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v4' }], ['path', { d: 'M20 16v1a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-1' }], ['path', { d: 'M14 8V7c0-1.1.9-2 2-2h2a2 2 0 0 1 2 2v1' }]],
	'align-center-vertical': [['path', { d: 'M12 2v20' }], ['path', { d: 'M8 10H4a2 2 0 0 1-2-2V6c0-1.1.9-2 2-2h4' }], ['path', { d: 'M16 10h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4' }], ['path', { d: 'M8 20H7a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2h1' }], ['path', { d: 'M16 14h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1' }]],
	'align-end-horizontal': [['rect', { width: '6', height: '16', x: '4', y: '2', rx: '2' }], ['rect', { width: '6', height: '9', x: '14', y: '9', rx: '2' }], ['path', { d: 'M22 22H2' }]],
	'align-end-vertical': [['rect', { width: '16', height: '6', x: '2', y: '4', rx: '2' }], ['rect', { width: '9', height: '6', x: '9', y: '14', rx: '2' }], ['path', { d: 'M22 22V2' }]],
	'align-horizontal-distribute-center': [['rect', { width: '6', height: '14', x: '4', y: '5', rx: '2' }], ['rect', { width: '6', height: '10', x: '14', y: '7', rx: '2' }], ['path', { d: 'M17 22v-5' }], ['path', { d: 'M17 7V2' }], ['path', { d: 'M7 22v-3' }], ['path', { d: 'M7 5V2' }]],
	'align-start-horizontal': [['rect', { width: '6', height: '16', x: '4', y: '6', rx: '2' }], ['rect', { width: '6', height: '9', x: '14', y: '6', rx: '2' }], ['path', { d: 'M22 2H2' }]],
	'align-start-vertical': [['rect', { width: '9', height: '6', x: '6', y: '14', rx: '2' }], ['rect', { width: '16', height: '6', x: '6', y: '4', rx: '2' }], ['path', { d: 'M2 2v20' }]],
	'align-vertical-distribute-center': [['path', { d: 'M22 17h-3' }], ['path', { d: 'M22 7h-5' }], ['path', { d: 'M5 17H2' }], ['path', { d: 'M7 7H2' }], ['rect', { x: '5', y: '14', width: '14', height: '6', rx: '2' }], ['rect', { x: '7', y: '4', width: '10', height: '6', rx: '2' }]],
	'archive': [['rect', { width: '20', height: '5', x: '2', y: '3', rx: '1' }], ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8' }], ['path', { d: 'M10 12h4' }]],
	'archive-restore': [['rect', { width: '20', height: '5', x: '2', y: '3', rx: '1' }], ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h2' }], ['path', { d: 'M20 8v11a2 2 0 0 1-2 2h-2' }], ['path', { d: 'm9 15 3-3 3 3' }], ['path', { d: 'M12 12v9' }]],
	'arrow-down': [['path', { d: 'M12 5v14' }], ['path', { d: 'm19 12-7 7-7-7' }]],
	'arrow-down-to-line': [['path', { d: 'M12 17V3' }], ['path', { d: 'm6 11 6 6 6-6' }], ['path', { d: 'M19 21H5' }]],
	'arrow-up': [['path', { d: 'm5 12 7-7 7 7' }], ['path', { d: 'M12 19V5' }]],
	'arrow-up-from-line': [['path', { d: 'm18 9-6-6-6 6' }], ['path', { d: 'M12 3v14' }], ['path', { d: 'M5 21h14' }]],
	'baseline': [['path', { d: 'M4 20h16' }], ['path', { d: 'm6 16 6-12 6 12' }], ['path', { d: 'M8 12h8' }]],
	'bell': [['path', { d: 'M10.268 21a2 2 0 0 0 3.464 0' }], ['path', { d: 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326' }]],
	'blend': [['circle', { cx: '9', cy: '9', r: '7' }], ['circle', { cx: '15', cy: '15', r: '7' }]],
	'bold': [['path', { d: 'M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8' }]],
	'box': [['path', { d: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z' }], ['path', { d: 'm3.3 7 8.7 5 8.7-5' }], ['path', { d: 'M12 22V12' }]],
	'boxes': [['path', { d: 'M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z' }], ['path', { d: 'm7 16.5-4.74-2.85' }], ['path', { d: 'm7 16.5 5-3' }], ['path', { d: 'M7 16.5v5.17' }], ['path', { d: 'M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z' }], ['path', { d: 'm17 16.5-5-3' }], ['path', { d: 'm17 16.5 4.74-2.85' }], ['path', { d: 'M17 16.5v5.17' }], ['path', { d: 'M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z' }], ['path', { d: 'M12 8 7.26 5.15' }], ['path', { d: 'm12 8 4.74-2.85' }], ['path', { d: 'M12 13.5V8' }]],
	'bring-to-front': [['rect', { x: '8', y: '8', width: '8', height: '8', rx: '2' }], ['path', { d: 'M4 10a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2' }], ['path', { d: 'M14 20a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2' }]],
	'case-sensitive': [['path', { d: 'm2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16' }], ['path', { d: 'M22 9v7' }], ['path', { d: 'M3.304 13h6.392' }], ['circle', { cx: '18.5', cy: '12.5', r: '3.5' }]],
	'check': [['path', { d: 'M20 6 9 17l-5-5' }]],
	'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
	'chevron-right': [['path', { d: 'm9 18 6-6-6-6' }]],
	'chevron-up': [['path', { d: 'm18 15-6-6-6 6' }]],
	'circle': [['circle', { cx: '12', cy: '12', r: '10' }]],
	'circle-alert': [['circle', { cx: '12', cy: '12', r: '10' }], ['line', { x1: '12', x2: '12', y1: '8', y2: '12' }], ['line', { x1: '12', x2: '12.01', y1: '16', y2: '16' }]],
	'circle-check': [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm9 12 2 2 4-4' }]],
	'circle-help': [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }], ['path', { d: 'M12 17h.01' }]],
	'circle-stop': [['circle', { cx: '12', cy: '12', r: '10' }], ['rect', { x: '9', y: '9', width: '6', height: '6', rx: '1' }]],
	'clipboard-paste': [['path', { d: 'M11 14h10' }], ['path', { d: 'M16 4h2a2 2 0 0 1 2 2v1.344' }], ['path', { d: 'm17 18 4-4-4-4' }], ['path', { d: 'M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113' }], ['rect', { x: '8', y: '2', width: '8', height: '4', rx: '1' }]],
	'cloud': [['path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }]],
	'cloud-cog': [['path', { d: 'm10.852 19.772-.383.924' }], ['path', { d: 'm13.148 14.228.383-.923' }], ['path', { d: 'M13.148 19.772a3 3 0 1 0-2.296-5.544l-.383-.923' }], ['path', { d: 'm13.53 20.696-.382-.924a3 3 0 1 1-2.296-5.544' }], ['path', { d: 'm14.772 15.852.923-.383' }], ['path', { d: 'm14.772 18.148.923.383' }], ['path', { d: 'M4.2 15.1a7 7 0 1 1 9.93-9.858A7 7 0 0 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2' }], ['path', { d: 'm9.228 15.852-.923-.383' }], ['path', { d: 'm9.228 18.148-.923.383' }]],
	'code': [['path', { d: 'm16 18 6-6-6-6' }], ['path', { d: 'm8 6-6 6 6 6' }]],
	'code-xml': [['path', { d: 'm18 16 4-4-4-4' }], ['path', { d: 'm6 8-4 4 4 4' }], ['path', { d: 'm14.5 4-5 16' }]],
	'component': [['path', { d: 'M15.536 11.293a1 1 0 0 0 0 1.414l2.376 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z' }], ['path', { d: 'M2.297 11.293a1 1 0 0 0 0 1.414l2.377 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414L6.088 8.916a1 1 0 0 0-1.414 0z' }], ['path', { d: 'M8.916 17.912a1 1 0 0 0 0 1.415l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.415l-2.377-2.376a1 1 0 0 0-1.414 0z' }], ['path', { d: 'M8.916 4.674a1 1 0 0 0 0 1.414l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z' }]],
	'container': [['path', { d: 'M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z' }], ['path', { d: 'M10 21.9V14L2.1 9.1' }], ['path', { d: 'm10 14 11.9-6.9' }], ['path', { d: 'M14 19.8v-8.1' }], ['path', { d: 'M18 17.5V9.4' }]],
	'copy': [['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }], ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]],
	'corner-down-right': [['path', { d: 'm15 10 5 5-5 5' }], ['path', { d: 'M4 4v7a4 4 0 0 0 4 4h12' }]],
	'cpu': [['path', { d: 'M12 20v2' }], ['path', { d: 'M12 2v2' }], ['path', { d: 'M17 20v2' }], ['path', { d: 'M17 2v2' }], ['path', { d: 'M2 12h2' }], ['path', { d: 'M2 17h2' }], ['path', { d: 'M2 7h2' }], ['path', { d: 'M20 12h2' }], ['path', { d: 'M20 17h2' }], ['path', { d: 'M20 7h2' }], ['path', { d: 'M7 20v2' }], ['path', { d: 'M7 2v2' }], ['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2' }], ['rect', { x: '8', y: '8', width: '8', height: '8', rx: '1' }]],
	'cylinder': [['ellipse', { cx: '12', cy: '5', rx: '9', ry: '3' }], ['path', { d: 'M3 5v14a9 3 0 0 0 18 0V5' }]],
	'database': [['ellipse', { cx: '12', cy: '5', rx: '9', ry: '3' }], ['path', { d: 'M3 5V19A9 3 0 0 0 21 19V5' }], ['path', { d: 'M3 12A9 3 0 0 0 21 12' }]],
	'diamond': [['path', { d: 'M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z' }]],
	'download': [['path', { d: 'M12 15V3' }], ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['path', { d: 'm7 10 5 5 5-5' }]],
	'ellipsis': [['circle', { cx: '12', cy: '12', r: '1' }], ['circle', { cx: '19', cy: '12', r: '1' }], ['circle', { cx: '5', cy: '12', r: '1' }]],
	'ellipsis-vertical': [['circle', { cx: '12', cy: '12', r: '1' }], ['circle', { cx: '12', cy: '5', r: '1' }], ['circle', { cx: '12', cy: '19', r: '1' }]],
	'eraser': [['path', { d: 'M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21' }], ['path', { d: 'm5.082 11.09 8.828 8.828' }]],
	'external-link': [['path', { d: 'M15 3h6v6' }], ['path', { d: 'M10 14 21 3' }], ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]],
	'eye': [['path', { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' }], ['circle', { cx: '12', cy: '12', r: '3' }]],
	'eye-off': [['path', { d: 'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49' }], ['path', { d: 'M14.084 14.158a3 3 0 0 1-4.242-4.242' }], ['path', { d: 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143' }], ['path', { d: 'm2 2 20 20' }]],
	'file': [['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }], ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }]],
	'file-plus': [['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }], ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }], ['path', { d: 'M9 15h6' }], ['path', { d: 'M12 18v-6' }]],
	'file-text': [['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }], ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }], ['path', { d: 'M10 9H8' }], ['path', { d: 'M16 13H8' }], ['path', { d: 'M16 17H8' }]],
	'flashlight': [['path', { d: 'M12 13v1' }], ['path', { d: 'M17 2a1 1 0 0 1 1 1v4a3 3 0 0 1-.6 1.8l-.6.8A4 4 0 0 0 16 12v8a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-8a4 4 0 0 0-.8-2.4l-.6-.8A3 3 0 0 1 6 7V3a1 1 0 0 1 1-1z' }], ['path', { d: 'M6 6h12' }]],
	'flip-horizontal-2': [['path', { d: 'm3 7 5 5-5 5V7' }], ['path', { d: 'm21 7-5 5 5 5V7' }], ['path', { d: 'M12 20v2' }], ['path', { d: 'M12 14v2' }], ['path', { d: 'M12 8v2' }], ['path', { d: 'M12 2v2' }]],
	'flip-vertical-2': [['path', { d: 'm17 3-5 5-5-5h10' }], ['path', { d: 'm17 21-5-5-5 5h10' }], ['path', { d: 'M4 12H2' }], ['path', { d: 'M10 12H8' }], ['path', { d: 'M16 12h-2' }], ['path', { d: 'M22 12h-2' }]],
	'folder': [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]],
	'folder-open': [['path', { d: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2' }]],
	'folder-plus': [['path', { d: 'M12 10v6' }], ['path', { d: 'M9 13h6' }], ['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]],
	'frame': [['line', { x1: '22', x2: '2', y1: '6', y2: '6' }], ['line', { x1: '22', x2: '2', y1: '18', y2: '18' }], ['line', { x1: '6', x2: '6', y1: '2', y2: '22' }], ['line', { x1: '18', x2: '18', y1: '2', y2: '22' }]],
	'git-branch': [['line', { x1: '6', x2: '6', y1: '3', y2: '15' }], ['circle', { cx: '18', cy: '6', r: '3' }], ['circle', { cx: '6', cy: '18', r: '3' }], ['path', { d: 'M18 9a9 9 0 0 1-9 9' }]],
	'globe': [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }], ['path', { d: 'M2 12h20' }]],
	'grid-3x3': [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }], ['path', { d: 'M3 9h18' }], ['path', { d: 'M3 15h18' }], ['path', { d: 'M9 3v18' }], ['path', { d: 'M15 3v18' }]],
	'group': [['path', { d: 'M3 7V5c0-1.1.9-2 2-2h2' }], ['path', { d: 'M17 3h2c1.1 0 2 .9 2 2v2' }], ['path', { d: 'M21 17v2c0 1.1-.9 2-2 2h-2' }], ['path', { d: 'M7 21H5c-1.1 0-2-.9-2-2v-2' }], ['rect', { width: '7', height: '5', x: '7', y: '7', rx: '1' }], ['rect', { width: '7', height: '5', x: '10', y: '12', rx: '1' }]],
	'hand': [['path', { d: 'M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2' }], ['path', { d: 'M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2' }], ['path', { d: 'M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8' }], ['path', { d: 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15' }]],
	'hard-drive': [['line', { x1: '22', x2: '2', y1: '12', y2: '12' }], ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }], ['line', { x1: '6', x2: '6.01', y1: '16', y2: '16' }], ['line', { x1: '10', x2: '10.01', y1: '16', y2: '16' }]],
	'heading-1': [['path', { d: 'M4 12h8' }], ['path', { d: 'M4 18V6' }], ['path', { d: 'M12 18V6' }], ['path', { d: 'm17 12 3-2v8' }]],
	'heading-2': [['path', { d: 'M4 12h8' }], ['path', { d: 'M4 18V6' }], ['path', { d: 'M12 18V6' }], ['path', { d: 'M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1' }]],
	'heading-3': [['path', { d: 'M4 12h8' }], ['path', { d: 'M4 18V6' }], ['path', { d: 'M12 18V6' }], ['path', { d: 'M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2' }], ['path', { d: 'M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2' }]],
	'hexagon': [['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }]],
	'highlighter': [['path', { d: 'm9 11-6 6v3h9l3-3' }], ['path', { d: 'm22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4' }]],
	'history': [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }], ['path', { d: 'M12 7v5l4 2' }]],
	'image': [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2', ry: '2' }], ['circle', { cx: '9', cy: '9', r: '2' }], ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' }]],
	'italic': [['line', { x1: '19', x2: '10', y1: '4', y2: '4' }], ['line', { x1: '14', x2: '5', y1: '20', y2: '20' }], ['line', { x1: '15', x2: '9', y1: '4', y2: '20' }]],
	'key': [['path', { d: 'm15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4' }], ['path', { d: 'm21 2-9.6 9.6' }], ['circle', { cx: '7.5', cy: '15.5', r: '5.5' }]],
	'keyboard': [['path', { d: 'M10 8h.01' }], ['path', { d: 'M12 12h.01' }], ['path', { d: 'M14 8h.01' }], ['path', { d: 'M16 12h.01' }], ['path', { d: 'M18 8h.01' }], ['path', { d: 'M6 8h.01' }], ['path', { d: 'M7 16h10' }], ['path', { d: 'M8 12h.01' }], ['rect', { width: '20', height: '16', x: '2', y: '4', rx: '2' }]],
	'layers': [['path', { d: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z' }], ['path', { d: 'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12' }], ['path', { d: 'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17' }]],
	'layout-panel-left': [['rect', { width: '7', height: '18', x: '3', y: '3', rx: '1' }], ['rect', { width: '7', height: '7', x: '14', y: '3', rx: '1' }], ['rect', { width: '7', height: '7', x: '14', y: '14', rx: '1' }]],
	'library-big': [['rect', { width: '8', height: '18', x: '3', y: '3', rx: '1' }], ['path', { d: 'M7 3v18' }], ['path', { d: 'M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z' }]],
	'link': [['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }], ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]],
	'list': [['path', { d: 'M3 5h.01' }], ['path', { d: 'M3 12h.01' }], ['path', { d: 'M3 19h.01' }], ['path', { d: 'M8 5h13' }], ['path', { d: 'M8 12h13' }], ['path', { d: 'M8 19h13' }]],
	'list-checks': [['path', { d: 'M13 5h8' }], ['path', { d: 'M13 12h8' }], ['path', { d: 'M13 19h8' }], ['path', { d: 'm3 17 2 2 4-4' }], ['path', { d: 'm3 7 2 2 4-4' }]],
	'list-ordered': [['path', { d: 'M11 5h10' }], ['path', { d: 'M11 12h10' }], ['path', { d: 'M11 19h10' }], ['path', { d: 'M4 4h1v5' }], ['path', { d: 'M4 9h2' }], ['path', { d: 'M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02' }]],
	'loader-circle': [['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }]],
	'locate-fixed': [['line', { x1: '2', x2: '5', y1: '12', y2: '12' }], ['line', { x1: '19', x2: '22', y1: '12', y2: '12' }], ['line', { x1: '12', x2: '12', y1: '2', y2: '5' }], ['line', { x1: '12', x2: '12', y1: '19', y2: '22' }], ['circle', { cx: '12', cy: '12', r: '7' }], ['circle', { cx: '12', cy: '12', r: '3' }]],
	'lock': [['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }], ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]],
	'lock-open': [['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }], ['path', { d: 'M7 11V7a5 5 0 0 1 9.9-1' }]],
	'mail': [['path', { d: 'm22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7' }], ['rect', { x: '2', y: '4', width: '20', height: '16', rx: '2' }]],
	'map': [['path', { d: 'M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z' }], ['path', { d: 'M15 5.764v15' }], ['path', { d: 'M9 3.236v15' }]],
	'maximize': [['path', { d: 'M8 3H5a2 2 0 0 0-2 2v3' }], ['path', { d: 'M21 8V5a2 2 0 0 0-2-2h-3' }], ['path', { d: 'M3 16v3a2 2 0 0 0 2 2h3' }], ['path', { d: 'M16 21h3a2 2 0 0 0 2-2v-3' }]],
	'maximize-2': [['path', { d: 'M15 3h6v6' }], ['path', { d: 'm21 3-7 7' }], ['path', { d: 'm3 21 7-7' }], ['path', { d: 'M9 21H3v-6' }]],
	'menu': [['path', { d: 'M4 5h16' }], ['path', { d: 'M4 12h16' }], ['path', { d: 'M4 19h16' }]],
	'map-pin': [['path', { d: 'M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0' }], ['circle', { cx: '12', cy: '10', r: '3' }]],
	'message-circle': [['path', { d: 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719' }]],
	'message-circle-plus': [['path', { d: 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719' }], ['path', { d: 'M8 12h8' }], ['path', { d: 'M12 8v8' }]],
	'message-square': [['path', { d: 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z' }]],
	'message-square-plus': [['path', { d: 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z' }], ['path', { d: 'M12 8v6' }], ['path', { d: 'M9 11h6' }]],
	'minimize-2': [['path', { d: 'm14 10 7-7' }], ['path', { d: 'M20 10h-6V4' }], ['path', { d: 'm3 21 7-7' }], ['path', { d: 'M4 14h6v6' }]],
	'minus': [['path', { d: 'M5 12h14' }]],
	'monitor': [['rect', { width: '20', height: '14', x: '2', y: '3', rx: '2' }], ['line', { x1: '8', x2: '16', y1: '21', y2: '21' }], ['line', { x1: '12', x2: '12', y1: '17', y2: '21' }]],
	'moon': [['path', { d: 'M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401' }]],
	'mouse-pointer-2': [['path', { d: 'M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z' }]],
	'move-right': [['path', { d: 'M18 8L22 12L18 16' }], ['path', { d: 'M2 12H22' }]],
	'move-up-right': [['path', { d: 'M13 5H19V11' }], ['path', { d: 'M19 5L5 19' }]],
	'network': [['rect', { x: '16', y: '16', width: '6', height: '6', rx: '1' }], ['rect', { x: '2', y: '16', width: '6', height: '6', rx: '1' }], ['rect', { x: '9', y: '2', width: '6', height: '6', rx: '1' }], ['path', { d: 'M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3' }], ['path', { d: 'M12 12V8' }]],
	'palette': [['path', { d: 'M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z' }], ['circle', { cx: '13.5', cy: '6.5', r: '.5', fill: 'currentColor' }], ['circle', { cx: '17.5', cy: '10.5', r: '.5', fill: 'currentColor' }], ['circle', { cx: '6.5', cy: '12.5', r: '.5', fill: 'currentColor' }], ['circle', { cx: '8.5', cy: '7.5', r: '.5', fill: 'currentColor' }]],
	'panel-left': [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }], ['path', { d: 'M9 3v18' }]],
	'panel-left-close': [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }], ['path', { d: 'M9 3v18' }], ['path', { d: 'm16 15-3-3 3-3' }]],
	'paperclip': [['path', { d: 'm16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551' }]],
	'pencil': [['path', { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }], ['path', { d: 'm15 5 4 4' }]],
	'pill': [['path', { d: 'm10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z' }], ['path', { d: 'm8.5 8.5 7 7' }]],
	'pin': [['path', { d: 'M12 17v5' }], ['path', { d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z' }]],
	'pin-off': [['path', { d: 'M12 17v5' }], ['path', { d: 'M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89' }], ['path', { d: 'm2 2 20 20' }], ['path', { d: 'M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11' }]],
	'pipette': [['path', { d: 'm12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12' }], ['path', { d: 'm18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z' }], ['path', { d: 'm2 22 .414-.414' }]],
	'plus': [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
	'redo-2': [['path', { d: 'm15 14 5-5-5-5' }], ['path', { d: 'M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13' }]],
	'rotate-cw': [['path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }]],
	'scan': [['path', { d: 'M3 7V5a2 2 0 0 1 2-2h2' }], ['path', { d: 'M17 3h2a2 2 0 0 1 2 2v2' }], ['path', { d: 'M21 17v2a2 2 0 0 1-2 2h-2' }], ['path', { d: 'M7 21H5a2 2 0 0 1-2-2v-2' }]],
	'scissors': [['circle', { cx: '6', cy: '6', r: '3' }], ['path', { d: 'M8.12 8.12 12 12' }], ['path', { d: 'M20 4 8.12 15.88' }], ['circle', { cx: '6', cy: '18', r: '3' }], ['path', { d: 'M14.8 14.8 20 20' }]],
	'scratch-board': [['path', { d: 'M2 6h4' }], ['path', { d: 'M2 10h4' }], ['path', { d: 'M2 14h4' }], ['path', { d: 'M2 18h4' }], ['rect', { width: '16', height: '20', x: '4', y: '2', rx: '2' }], ['path', { d: 'M15 2v20' }], ['path', { d: 'M15 7h5' }], ['path', { d: 'M15 12h5' }], ['path', { d: 'M15 17h5' }]],
	'search': [['path', { d: 'm21 21-4.34-4.34' }], ['circle', { cx: '11', cy: '11', r: '8' }]],
	'send-to-back': [['rect', { x: '14', y: '14', width: '8', height: '8', rx: '2' }], ['rect', { x: '2', y: '2', width: '8', height: '8', rx: '2' }], ['path', { d: 'M7 14v1a2 2 0 0 0 2 2h1' }], ['path', { d: 'M14 7h1a2 2 0 0 1 2 2v1' }]],
	'server': [['rect', { width: '20', height: '8', x: '2', y: '2', rx: '2', ry: '2' }], ['rect', { width: '20', height: '8', x: '2', y: '14', rx: '2', ry: '2' }], ['line', { x1: '6', x2: '6.01', y1: '6', y2: '6' }], ['line', { x1: '6', x2: '6.01', y1: '18', y2: '18' }]],
	'settings': [['path', { d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915' }], ['circle', { cx: '12', cy: '12', r: '3' }]],
	'shapes': [['path', { d: 'M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z' }], ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }], ['circle', { cx: '17.5', cy: '17.5', r: '3.5' }]],
	'shield': [['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }]],
	'smartphone': [['rect', { width: '14', height: '20', x: '5', y: '2', rx: '2', ry: '2' }], ['path', { d: 'M12 18h.01' }]],
	'sparkles': [['path', { d: 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z' }], ['path', { d: 'M20 2v4' }], ['path', { d: 'M22 4h-4' }], ['circle', { cx: '4', cy: '20', r: '2' }]],
	'spline': [['circle', { cx: '19', cy: '5', r: '2' }], ['circle', { cx: '5', cy: '19', r: '2' }], ['path', { d: 'M5 17A12 12 0 0 1 17 5' }]],
	'square': [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }]],
	'square-dashed': [['path', { d: 'M5 3a2 2 0 0 0-2 2' }], ['path', { d: 'M19 3a2 2 0 0 1 2 2' }], ['path', { d: 'M21 19a2 2 0 0 1-2 2' }], ['path', { d: 'M5 21a2 2 0 0 1-2-2' }], ['path', { d: 'M9 3h1' }], ['path', { d: 'M9 21h1' }], ['path', { d: 'M14 3h1' }], ['path', { d: 'M14 21h1' }], ['path', { d: 'M3 9v1' }], ['path', { d: 'M21 9v1' }], ['path', { d: 'M3 14v1' }], ['path', { d: 'M21 14v1' }]],
	'star': [['path', { d: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z' }]],
	'sticky-note': [['path', { d: 'M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z' }], ['path', { d: 'M15 3v5a1 1 0 0 0 1 1h5' }]],
	'strikethrough': [['path', { d: 'M16 4H9a3 3 0 0 0-2.83 4' }], ['path', { d: 'M14 12a4 4 0 0 1 0 8H6' }], ['line', { x1: '4', x2: '20', y1: '12', y2: '12' }]],
	'sun': [['circle', { cx: '12', cy: '12', r: '4' }], ['path', { d: 'M12 2v2' }], ['path', { d: 'M12 20v2' }], ['path', { d: 'm4.93 4.93 1.41 1.41' }], ['path', { d: 'm17.66 17.66 1.41 1.41' }], ['path', { d: 'M2 12h2' }], ['path', { d: 'M20 12h2' }], ['path', { d: 'm6.34 17.66-1.41 1.41' }], ['path', { d: 'm19.07 4.93-1.41 1.41' }]],
	'table': [['path', { d: 'M12 3v18' }], ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }], ['path', { d: 'M3 9h18' }], ['path', { d: 'M3 15h18' }]],
	'text-align-center': [['path', { d: 'M21 5H3' }], ['path', { d: 'M17 12H7' }], ['path', { d: 'M19 19H5' }]],
	'text-align-end': [['path', { d: 'M21 5H3' }], ['path', { d: 'M21 12H9' }], ['path', { d: 'M21 19H7' }]],
	'text-align-start': [['path', { d: 'M21 5H3' }], ['path', { d: 'M15 12H3' }], ['path', { d: 'M17 19H3' }]],
	'text-cursor-input': [['path', { d: 'M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6' }], ['path', { d: 'M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7' }], ['path', { d: 'M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1' }], ['path', { d: 'M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1' }], ['path', { d: 'M9 6v12' }]],
	'text-quote': [['path', { d: 'M17 5H3' }], ['path', { d: 'M21 12H8' }], ['path', { d: 'M21 19H8' }], ['path', { d: 'M3 12v7' }]],
	'trash-2': [['path', { d: 'M10 11v6' }], ['path', { d: 'M14 11v6' }], ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }], ['path', { d: 'M3 6h18' }], ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }]],
	'triangle': [['path', { d: 'M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z' }]],
	'type': [['path', { d: 'M12 4v16' }], ['path', { d: 'M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2' }], ['path', { d: 'M9 20h6' }]],
	'underline': [['path', { d: 'M6 4v6a6 6 0 0 0 12 0V4' }], ['line', { x1: '4', x2: '20', y1: '20', y2: '20' }]],
	'undo-2': [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11' }]],
	'ungroup': [['rect', { width: '8', height: '6', x: '5', y: '4', rx: '1' }], ['rect', { width: '8', height: '6', x: '11', y: '14', rx: '1' }]],
	'upload': [['path', { d: 'M12 3v12' }], ['path', { d: 'm17 8-5-5-5 5' }], ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }]],
	'user': [['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }], ['circle', { cx: '12', cy: '7', r: '4' }]],
	'users': [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['path', { d: 'M16 3.128a4 4 0 0 1 0 7.744' }], ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }], ['circle', { cx: '9', cy: '7', r: '4' }]],
	'wand-sparkles': [['path', { d: 'm21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72' }], ['path', { d: 'm14 7 3 3' }], ['path', { d: 'M5 6v4' }], ['path', { d: 'M19 14v4' }], ['path', { d: 'M10 2v2' }], ['path', { d: 'M7 8H3' }], ['path', { d: 'M21 16h-4' }], ['path', { d: 'M11 3H9' }]],
	'workflow': [['rect', { width: '8', height: '8', x: '3', y: '3', rx: '2' }], ['path', { d: 'M7 11v4a2 2 0 0 0 2 2h4' }], ['rect', { width: '8', height: '8', x: '13', y: '13', rx: '2' }]],
	'x': [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
	'zap': [['path', { d: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z' }]],
};

/** Property swatches: stroke widths, styles, sloppiness, fills, edges, connectors, arrowheads. */
const CUSTOM: Readonly<Record<string, readonly IconNode[]>> = {
	'stroke-thin': [['path', { d: 'M4 12h16', 'stroke-width': '1' }]],
	'stroke-bold': [['path', { d: 'M4 12h16', 'stroke-width': '2.5' }]],
	'stroke-extra': [['path', { d: 'M4 12h16', 'stroke-width': '4.5' }]],
	'style-solid': [['path', { d: 'M4 12h16', 'stroke-width': '2' }]],
	'style-dashed': [['path', { d: 'M4 12h16', 'stroke-width': '2', 'stroke-dasharray': '4 3.2', 'stroke-linecap': 'butt' }]],
	'style-dotted': [['path', { d: 'M4.5 12h16', 'stroke-width': '2', 'stroke-dasharray': '0.1 3.6' }]],
	'sloppy-0': [['path', { d: 'M3.5 16c3-6 6.5-9 9-6s5 4 8-3', 'stroke-width': '1.75' }]],
	'sloppy-1': [['path', { d: 'M3.5 16c1.5-2.8 2.4-4.6 4.2-6.4c1.2-1.2 2.6-.6 3.4.4c1 1.3 1.9 2.9 3.6 3.2c2 .3 3.6-1.8 5.8-6.2M4 15.2c1.6-2.6 3.1-5 4.6-5.9', 'stroke-width': '1.6' }]],
	'sloppy-2': [['path', { d: 'M3.4 16.4c1.2-2 2.2-4.8 3.8-6.2c1.5-1.4 3.1-.9 3.9.5c.9 1.6 1.4 3.7 3.4 3.9c2.1.2 3.2-2.3 6-7.1M4.2 15.1c1.3-1.4 2.2-4.8 4.6-5.6c1.6-.5 2.4 1.5 3.1 2.6M13.8 13.6c1.9 1.1 3.4-.9 5-4.4', 'stroke-width': '1.5' }]],
	'fill-hachure': [['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2.5', 'stroke-width': '1.5' }], ['path', { d: 'M5 13l8-8M5 19l14-14M11 19l8-8', 'stroke-width': '1.25' }]],
	'fill-cross-hatch': [['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2.5', 'stroke-width': '1.5' }], ['path', { d: 'M5 13l8-8M5 19l14-14M11 19l8-8M5 11l8 8M5 5l14 14M11 5l8 8', 'stroke-width': '1' }]],
	'fill-solid': [['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2.5', fill: 'currentColor', 'stroke-width': '1.5' }]],
	'edge-sharp': [['path', { d: 'M5 19V5h14', 'stroke-width': '1.75', 'stroke-dasharray': '2 0' }]],
	'edge-round': [['path', { d: 'M5 19v-8a6 6 0 0 1 6-6h8', 'stroke-width': '1.75' }]],
	'arrow-type-sharp': [['path', { d: 'M5 19L19 5', 'stroke-width': '1.75' }], ['path', { d: 'M11 5h8v8', 'stroke-width': '1.75' }]],
	'arrow-type-round': [['path', { d: 'M5 19c0-8 4-14 13-14', 'stroke-width': '1.75' }], ['path', { d: 'M14 2l4 3-4 3', 'stroke-width': '1.75' }]],
	'arrow-type-elbow': [['path', { d: 'M5 19h7V6h7', 'stroke-width': '1.75' }], ['path', { d: 'M16 3l3 3-3 3', 'stroke-width': '1.75' }]],
	'head-none': [['path', { d: 'M3 12h18', 'stroke-width': '1.75' }]],
	'head-arrow': [['path', { d: 'M3 12h17', 'stroke-width': '1.75' }], ['path', { d: 'M14 6l6 6-6 6', 'stroke-width': '1.75' }]],
	'head-triangle': [['path', { d: 'M3 12h12', 'stroke-width': '1.75' }], ['path', { d: 'M14 6.5l7 5.5-7 5.5z', fill: 'currentColor', 'stroke-width': '1.5' }]],
	'head-triangle-outline': [['path', { d: 'M3 12h11', 'stroke-width': '1.75' }], ['path', { d: 'M14 6.5l7 5.5-7 5.5z', 'stroke-width': '1.5' }]],
	'head-dot': [['path', { d: 'M3 12h12', 'stroke-width': '1.75' }], ['circle', { cx: '17.5', cy: '12', r: '3.5', fill: 'currentColor', 'stroke-width': '1.25' }]],
	'head-circle': [['path', { d: 'M3 12h11', 'stroke-width': '1.75' }], ['circle', { cx: '17.5', cy: '12', r: '3.5', 'stroke-width': '1.5' }]],
	'head-bar': [['path', { d: 'M3 12h17', 'stroke-width': '1.75' }], ['path', { d: 'M20 6v12', 'stroke-width': '1.75' }]],
	'head-diamond': [['path', { d: 'M3 12h10', 'stroke-width': '1.75' }], ['path', { d: 'M17 8l4 4-4 4-4-4z', fill: 'currentColor', 'stroke-width': '1.5' }]],
	'head-diamond-outline': [['path', { d: 'M3 12h10', 'stroke-width': '1.75' }], ['path', { d: 'M17 8l4 4-4 4-4-4z', 'stroke-width': '1.5' }]],
	'head-crowfoot-one': [['path', { d: 'M3 12h18', 'stroke-width': '1.75' }], ['path', { d: 'M17 6v12', 'stroke-width': '1.75' }]],
	'head-crowfoot-many': [['path', { d: 'M3 12h18', 'stroke-width': '1.75' }], ['path', { d: 'M21 6l-6 6 6 6', 'stroke-width': '1.75' }]],
	'head-crowfoot-one-or-many': [['path', { d: 'M3 12h18', 'stroke-width': '1.75' }], ['path', { d: 'M21 6l-6 6 6 6M12 6v12', 'stroke-width': '1.75' }]],
	'text-hand': [['path', { d: 'M4.5 18.5c2.2-5.6 4.3-11.6 6.4-13.1c.9-.6 1.5.6 1.9 2.1c.9 3.5 2.2 7.8 3.4 10.9M6.8 13.1c2.8-.6 5.7-.8 8.5-.6M17.8 9.4c.5 2.9.7 6.1.4 9.3', 'stroke-width': '1.6' }]],
	'text-sans': [['path', { d: 'M5 19L11.1 5h1.8L19 19M7.4 14h9.2', 'stroke-width': '1.6' }]],
	'text-serif': [['path', { d: 'M4 19h4M16 19h4M6 19l6-14 6 14M8.2 14h7.6M10 5h4', 'stroke-width': '1.5' }]],
	'text-mono': [['path', { d: 'M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16', 'stroke-width': '1.6' }]],
	'font-small': [['path', { d: 'M8 17l4-10 4 10M9.4 14h5.2', 'stroke-width': '1.6' }]],
	'font-medium': [['path', { d: 'M6.5 18.5l5.5-13 5.5 13M8.3 14.5h7.4', 'stroke-width': '1.7' }]],
	'font-large': [['path', { d: 'M5 20l7-16 7 16M7.4 15h9.2', 'stroke-width': '1.8' }]],
	'font-huge': [['path', { d: 'M3.5 21.5l8.5-19 8.5 19M6.5 15.5h11', 'stroke-width': '2' }]],
	'grid-dots': [['circle', { cx: '6', cy: '6', r: '1', fill: 'currentColor' }], ['circle', { cx: '12', cy: '6', r: '1', fill: 'currentColor' }], ['circle', { cx: '18', cy: '6', r: '1', fill: 'currentColor' }], ['circle', { cx: '6', cy: '12', r: '1', fill: 'currentColor' }], ['circle', { cx: '12', cy: '12', r: '1', fill: 'currentColor' }], ['circle', { cx: '18', cy: '12', r: '1', fill: 'currentColor' }], ['circle', { cx: '6', cy: '18', r: '1', fill: 'currentColor' }], ['circle', { cx: '12', cy: '18', r: '1', fill: 'currentColor' }], ['circle', { cx: '18', cy: '18', r: '1', fill: 'currentColor' }]],
	'grid-none': [['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2.5', 'stroke-dasharray': '2.5 2.5' }]],
	'connector-dot': [['circle', { cx: '12', cy: '12', r: '3', fill: 'currentColor' }]],
	'shape-parallelogram': [['path', { d: 'M7.5 5H21l-4.5 14H3z' }]],
	'shape-pill': [['rect', { x: '2.5', y: '7', width: '19', height: '10', rx: '5' }]],
	'shape-document': [['path', { d: 'M4 4h16v12.5c-2.6-1.6-5.2-1.6-8 0s-5.4 1.6-8 0z' }]],
	// The chat composer's send arrow (agentEditor.ts createSendIcon), for sends that should look like the chat's.
	'chat-send': [['path', { d: 'm19.03 9.47l-6.145-6.145a1.26 1.26 0 0 0-1.77 0L4.97 9.47l1.06 1.06l5.22-5.22V21h1.5V5.31l5.22 5.22z', fill: 'currentColor', stroke: 'currentColor', 'stroke-width': '1.3' }]],
	// Volt's agent mark: a four-point spark (drawn on a 512 grid, fitted to 2..22 like Lucide's).
	'agent-spark': [['path', { d: 'M512 256.5c-137.5 8.4-247.1 118-255.5 255.5h-1C247.1 374.5 137.5 264.9 0 256.5v-1c137.5-8.4 247.1-118 255.5-255.5h1c8.4 137.5 118 247.1 255.5 255.5z', transform: 'translate(2 2) scale(0.0390625)', fill: 'currentColor', stroke: 'none' }]],
};

/** Tabler outline icons (24px grid, same stroke style as Lucide) for the library's system design blocks. */
const TABLER: Readonly<Record<string, readonly IconNode[]>> = {
	'tabler-device-desktop': [['path', { d: 'M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10z' }], ['path', { d: 'M7 20h10' }], ['path', { d: 'M9 16v4' }], ['path', { d: 'M15 16v4' }]],
	'tabler-device-mobile': [['path', { d: 'M6 5a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-14z' }], ['path', { d: 'M11 4h2' }], ['path', { d: 'M12 17v.01' }]],
	'tabler-user': [['path', { d: 'M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0' }], ['path', { d: 'M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2' }]],
	'tabler-api': [['path', { d: 'M4 13h5' }], ['path', { d: 'M12 16v-8h3a2 2 0 0 1 2 2v1a2 2 0 0 1 -2 2h-3' }], ['path', { d: 'M20 8v8' }], ['path', { d: 'M9 16v-5.5a2.5 2.5 0 0 0 -5 0v5.5' }]],
	'tabler-server-2': [['path', { d: 'M3 4m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z' }], ['path', { d: 'M3 12m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z' }], ['path', { d: 'M7 8l0 .01' }], ['path', { d: 'M7 16l0 .01' }], ['path', { d: 'M11 8h6' }], ['path', { d: 'M11 16h6' }]],
	'tabler-database': [['path', { d: 'M12 6m-8 0a8 3 0 1 0 16 0a8 3 0 1 0 -16 0' }], ['path', { d: 'M4 6v6a8 3 0 0 0 16 0v-6' }], ['path', { d: 'M4 12v6a8 3 0 0 0 16 0v-6' }]],
	'tabler-server-bolt': [['path', { d: 'M3 4m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z' }], ['path', { d: 'M15 20h-9a3 3 0 0 1 -3 -3v-2a3 3 0 0 1 3 -3h12' }], ['path', { d: 'M7 8v.01' }], ['path', { d: 'M7 16v.01' }], ['path', { d: 'M20 15l-2 3h3l-2 3' }]],
	'tabler-stack-push': [['path', { d: 'M6 10l-2 1l8 4l8 -4l-2 -1' }], ['path', { d: 'M4 15l8 4l8 -4' }], ['path', { d: 'M12 4v7' }], ['path', { d: 'M15 8l-3 3l-3 -3' }]],
	'tabler-bucket': [['path', { d: 'M12 7m-8 0a8 4 0 1 0 16 0a8 4 0 1 0 -16 0' }], ['path', { d: 'M4 7c0 .664 .088 1.324 .263 1.965l2.737 10.035c.5 1.5 2.239 2 5 2s4.5 -.5 5 -2c.333 -1 1.246 -4.345 2.737 -10.035a7.45 7.45 0 0 0 .263 -1.965' }]],
	'tabler-lambda': [['path', { d: 'M6 20l6.5 -9' }], ['path', { d: 'M19 20c-6 0 -6 -16 -12 -16' }]],
	'tabler-load-balancer': [['path', { d: 'M12 13m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0' }], ['path', { d: 'M12 20m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0' }], ['path', { d: 'M12 16v3' }], ['path', { d: 'M12 10v-7' }], ['path', { d: 'M9 6l3 -3l3 3' }], ['path', { d: 'M14.894 12.227l6.11 -2.224' }], ['path', { d: 'M17.159 8.21l3.845 1.793l-1.793 3.845' }], ['path', { d: 'M9.101 12.214l-6.075 -2.211' }], ['path', { d: 'M6.871 8.21l-3.845 1.793l1.793 3.845' }]],
	'tabler-box': [['path', { d: 'M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5' }], ['path', { d: 'M12 12l8 -4.5' }], ['path', { d: 'M12 12l0 9' }], ['path', { d: 'M12 12l-8 -4.5' }]],
	'tabler-cloud': [['path', { d: 'M6.657 18c-2.572 0 -4.657 -2.007 -4.657 -4.483c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927 -1.551 3.487 -3.465 3.487h-11.878' }]],
	'tabler-shield-lock': [['path', { d: 'M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3' }], ['path', { d: 'M12 11m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0' }], ['path', { d: 'M12 12l0 2.5' }]],
	'tabler-plug-connected': [['path', { d: 'M7 12l5 5l-1.5 1.5a3.536 3.536 0 1 1 -5 -5l1.5 -1.5z' }], ['path', { d: 'M17 12l-5 -5l1.5 -1.5a3.536 3.536 0 1 1 5 5l-1.5 1.5z' }], ['path', { d: 'M3 21l2.5 -2.5' }], ['path', { d: 'M18.5 5.5l2.5 -2.5' }], ['path', { d: 'M10 11l-2 2' }], ['path', { d: 'M13 14l-2 2' }]],
	'tabler-bell-ringing': [['path', { d: 'M10 5a2 2 0 0 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6' }], ['path', { d: 'M9 17v1a3 3 0 0 0 6 0v-1' }], ['path', { d: 'M21 6.727a11.05 11.05 0 0 0 -2.794 -3.727' }], ['path', { d: 'M3 6.727a11.05 11.05 0 0 1 2.792 -3.727' }]],
	'tabler-settings-automation': [['path', { d: 'M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z' }], ['path', { d: 'M10 9v6l5 -3z' }]],
};

export type ScratchIconName = keyof typeof LUCIDE | keyof typeof CUSTOM | keyof typeof TABLER;

export const SHAPE_LABELS: Readonly<Record<ScratchShapeKind, string>> = {
	rectangle: localize('voltScratch.shape.rectangle', "Rectangle"),
	diamond: localize('voltScratch.shape.diamond', "Diamond"),
	ellipse: localize('voltScratch.shape.ellipse', "Ellipse"),
	triangle: localize('voltScratch.shape.triangle', "Triangle"),
	hexagon: localize('voltScratch.shape.hexagon', "Hexagon"),
	parallelogram: localize('voltScratch.shape.parallelogram', "Parallelogram"),
	cylinder: localize('voltScratch.shape.cylinder', "Cylinder"),
	pill: localize('voltScratch.shape.pill', "Pill"),
	document: localize('voltScratch.shape.document', "Document"),
	cloud: localize('voltScratch.shape.cloud', "Cloud"),
	star: localize('voltScratch.shape.star', "Star"),
};

export const SHAPE_ICONS: Readonly<Record<ScratchShapeKind, ScratchIconName>> = {
	rectangle: 'square', diamond: 'diamond', ellipse: 'circle', triangle: 'triangle', hexagon: 'hexagon', parallelogram: 'shape-parallelogram',
	cylinder: 'cylinder', pill: 'shape-pill', document: 'shape-document', cloud: 'cloud', star: 'star',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface IScratchIconOptions {
	readonly size?: number;
	readonly strokeWidth?: number;
	readonly className?: string;
	/** Mirror left to right (start arrowheads). */
	readonly mirror?: boolean;
}

export function scratchIcon(doc: Document, name: ScratchIconName | string, options: IScratchIconOptions = {}): SVGSVGElement {
	const size = options.size ?? 16;
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', String(options.strokeWidth ?? 1.75));
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('sx-icon');
	if (options.className) {
		for (const cls of options.className.split(/\s+/).filter(Boolean)) {
			svg.classList.add(cls);
		}
	}
	const nodes = CUSTOM[name] ?? LUCIDE[name] ?? TABLER[name] ?? LUCIDE['square'];
	const parent: SVGElement = options.mirror ? svg.appendChild(doc.createElementNS(SVG_NS, 'g')) : svg;
	if (options.mirror) {
		parent.setAttribute('transform', 'translate(24 0) scale(-1 1)');
	}
	for (const [tag, attrs] of nodes) {
		const child = doc.createElementNS(SVG_NS, tag);
		for (const [key, value] of Object.entries(attrs)) {
			child.setAttribute(key, value);
		}
		parent.appendChild(child);
	}
	return svg;
}

export function hasScratchIcon(name: string): boolean {
	return name in CUSTOM || name in LUCIDE || name in TABLER;
}

/** An icon as SVG text, for icon elements on the board (shown through an image, never parsed). */
export function iconSvgMarkup(name: string, strokeWidth = 1.75): string {
	const nodes = CUSTOM[name] ?? LUCIDE[name] ?? TABLER[name];
	if (!nodes) {
		return '';
	}
	const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	const body = nodes.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`).join('');
	return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
