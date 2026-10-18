/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One icon set for the web and mobile apps: 24x24 stroke paths (1.75 wide, round caps), drawn as
 * `<svg>` on the web and with react-native-svg on phones, so both show exactly the same glyphs.
 * Shapes follow the line icons of Volt's desktop chrome.
 */
export interface IIconDef {
	readonly paths: readonly string[];
	/** Filled instead of stroked. */
	readonly fill?: boolean;
}

function circle(cx: number, cy: number, r: number): string {
	return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
}

function rect(x: number, y: number, w: number, h: number, r: number): string {
	return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`;
}

const SHIELD = 'M12 21.5s7.5-3.6 7.5-9.6V5.3L12 2.5 4.5 5.3v6.6c0 6 7.5 9.6 7.5 9.6Z';
const BOLT = 'M13.2 2.2 4.6 13.4h6.6l-1.2 8.4 8.6-11.2h-6.6l1.2-8.4Z';

export const ICONS = {
	bolt: { paths: [BOLT], fill: true },
	zap: { paths: [BOLT] },
	plus: { paths: ['M12 5v14', 'M5 12h14'] },
	minus: { paths: ['M5 12h14'] },
	search: { paths: [circle(11, 11, 7), 'm20 20-3.6-3.6'] },
	settings: { paths: ['M4 7h9', 'M17 7h3', circle(15, 7, 2), 'M4 17h3', 'M11 17h9', circle(9, 17, 2)] },
	chevronRight: { paths: ['m9 6 6 6-6 6'] },
	chevronLeft: { paths: ['m15 6-6 6 6 6'] },
	chevronDown: { paths: ['m6 9 6 6 6-6'] },
	chevronUp: { paths: ['m6 15 6-6 6 6'] },
	chevronsUpDown: { paths: ['m7 15 5 5 5-5', 'm7 9 5-5 5 5'] },
	close: { paths: ['M18 6 6 18', 'm6 6 12 12'] },
	check: { paths: ['M20 6 9 17l-5-5'] },
	checkCircle: { paths: [circle(12, 12, 9), 'm8.5 12.5 2.5 2.5 5-5.5'] },
	xCircle: { paths: [circle(12, 12, 9), 'm15 9-6 6', 'm9 9 6 6'] },
	alert: { paths: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z', 'M12 9v4', 'M12 17h.01'] },
	alertCircle: { paths: [circle(12, 12, 9), 'M12 8v4.5', 'M12 16h.01'] },
	info: { paths: [circle(12, 12, 9), 'M12 16v-4.5', 'M12 8h.01'] },
	help: { paths: [circle(12, 12, 9), 'M9.2 9a2.9 2.9 0 0 1 5.6 1c0 2-2.8 2.6-2.8 4', 'M12 17.2h.01'] },
	shield: { paths: [SHIELD] },
	shieldAlert: { paths: [SHIELD, 'M12 8v4', 'M12 15.5h.01'] },
	shieldCheck: { paths: [SHIELD, 'm9 12 2 2 4-4'] },
	terminal: { paths: ['m4 17 6-6-6-6', 'M12 19h8'] },
	file: { paths: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6'] },
	fileDiff: { paths: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6', 'M12 11v6', 'M9 14h6'] },
	pencil: { paths: ['M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z', 'm15 5 4 4'] },
	folder: { paths: ['M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z'] },
	folderPlus: { paths: ['M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z', 'M12 10v6', 'M9 13h6'] },
	eye: { paths: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', circle(12, 12, 3)] },
	globe: { paths: [circle(12, 12, 9.5), 'M2.5 12h19', 'M12 2.5a14.5 14.5 0 0 1 3.8 9.5 14.5 14.5 0 0 1-3.8 9.5 14.5 14.5 0 0 1-3.8-9.5A14.5 14.5 0 0 1 12 2.5Z'] },
	sparkles: { paths: ['M12 3.5 13.8 8.2 18.5 10l-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8Z', 'M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z'] },
	thought: { paths: ['M9 18h6', 'M10 21.5h4', 'M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.5.4.8.9.8 1.5V17h6v-1.2c0-.6.3-1.1.8-1.5A6.5 6.5 0 0 0 12 2.5Z'] },
	stop: { paths: [rect(6, 6, 12, 12, 2.5)], fill: true },
	arrowUp: { paths: ['M12 19V5', 'm5.5 11.5 6.5-6.5 6.5 6.5'] },
	arrowDown: { paths: ['M12 5v14', 'm18.5 12.5-6.5 6.5-6.5-6.5'] },
	arrowRight: { paths: ['M5 12h14', 'm12.5 5.5 6.5 6.5-6.5 6.5'] },
	pin: { paths: ['M12 17v5', 'M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2v.8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z'] },
	archive: { paths: [rect(2.5, 3.5, 19, 5, 1.2), 'M4.5 8.5V19a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5', 'M10 12.5h4'] },
	inbox: { paths: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z'] },
	trash: { paths: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'] },
	clock: { paths: [circle(12, 12, 9), 'M12 7v5l3.2 2'] },
	history: { paths: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'] },
	moon: { paths: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'] },
	sun: { paths: [circle(12, 12, 4), 'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41'] },
	contrast: { paths: [circle(12, 12, 9), 'M12 3a9 9 0 0 1 0 18Z'] },
	more: { paths: [circle(5, 12, 1.7), circle(12, 12, 1.7), circle(19, 12, 1.7)], fill: true },
	copy: { paths: [rect(8, 8, 13.5, 13.5, 2.2), 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'] },
	link: { paths: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'] },
	external: { paths: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'] },
	branch: { paths: ['M6 3v12', circle(18, 6, 3), circle(6, 18, 3), 'M18 9a9 9 0 0 1-9 9'] },
	pullRequest: { paths: [circle(18, 18, 3), circle(6, 6, 3), 'M13 6h3a2 2 0 0 1 2 2v7', 'M6 9v12'] },
	cpu: { paths: [rect(4.5, 4.5, 15, 15, 2.2), rect(9, 9, 6, 6, 1), 'M15 2v2.5', 'M15 19.5V22', 'M2 15h2.5', 'M2 9h2.5', 'M19.5 15H22', 'M19.5 9H22', 'M9 2v2.5', 'M9 19.5V22'] },
	layers: { paths: ['m12 2.5 9.5 4.8L12 12 2.5 7.3Z', 'm2.5 16.7 9.5 4.8 9.5-4.8', 'm2.5 12 9.5 4.8 9.5-4.8'] },
	agents: { paths: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', circle(9, 7, 4), 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'] },
	user: { paths: [circle(12, 8, 4), 'M20 21a8 8 0 0 0-16 0'] },
	wifi: { paths: ['M5 12.55a11 11 0 0 1 14.08 0', 'M1.42 9a16 16 0 0 1 21.16 0', 'M8.53 16.11a6 6 0 0 1 6.95 0', 'M12 20h.01'] },
	wifiOff: { paths: ['m2 2 20 20', 'M8.5 16.5a5 5 0 0 1 7 0', 'M2 8.82a15 15 0 0 1 4.17-2.65', 'M10.66 5c4.01-.36 8.14.9 11.34 3.76', 'M16.85 11.25a10 10 0 0 1 2.22 1.68', 'M5 13a10 10 0 0 1 5.24-2.76', 'M12 20h.01'] },
	qr: { paths: [rect(3, 3, 7, 7, 1.2), rect(14, 3, 7, 7, 1.2), rect(3, 14, 7, 7, 1.2), 'M14 14h3v3', 'M21 14v.01', 'M14 21h.01', 'M17.5 17.5H21V21h-3.5Z'] },
	camera: { paths: ['M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z', circle(12, 13, 3.2)] },
	refresh: { paths: ['M21 12a9 9 0 0 1-15.5 6.2L3 16', 'M3 21v-5h5', 'M3 12a9 9 0 0 1 15.5-6.2L21 8', 'M21 3v5h-5'] },
	logOut: { paths: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'] },
	laptop: { paths: [rect(4, 4.5, 16, 11.5, 2), 'M2 19.5h20'] },
	phone: { paths: [rect(6.5, 2, 11, 20, 2.5), 'M11 18h2'] },
	server: { paths: [rect(2.5, 2.5, 19, 8, 2), rect(2.5, 13.5, 19, 8, 2), 'M6.5 6.5h.01', 'M6.5 17.5h.01'] },
	list: { paths: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'] },
	listChecks: { paths: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'] },
	play: { paths: ['M7 4.5v15l12-7.5Z'] },
	pause: { paths: ['M8.5 5v14', 'M15.5 5v14'] },
	undo: { paths: ['M3 7v6h6', 'M21 17a9 9 0 0 0-15-6.7L3 13'] },
	bell: { paths: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'] },
	lock: { paths: [rect(3.5, 11, 17, 10.5, 2), 'M7.5 11V7a4.5 4.5 0 0 1 9 0v4'] },
	key: { paths: [circle(7.5, 15.5, 5), 'm21 2-9.6 9.6', 'm15.5 7.5 3 3L22 7l-3-3'] },
	code: { paths: ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'] },
	image: { paths: [rect(3, 3, 18, 18, 2.2), circle(9, 9, 2), 'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21'] },
	paperclip: { paths: ['m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5'] },
	mic: { paths: [rect(9, 2.5, 6, 12, 3), 'M19 10.5v1a7 7 0 0 1-14 0v-1', 'M12 18.5V22'] },
	menu: { paths: ['M4 6h16', 'M4 12h16', 'M4 18h16'] },
	sidebar: { paths: [rect(3, 3.5, 18, 17, 2.2), 'M9 3.5v17'] },
	filter: { paths: ['M22 3H2l8 9.46V19l4 2v-8.54Z'] },
	message: { paths: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z'] },
	compose: { paths: ['M12 3.5H5.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V12', 'M18.4 2.6a2.1 2.1 0 1 1 3 3L12 15l-4 1 1-4Z'] },
	book: { paths: ['M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20'] },
	minimize: { paths: ['M8 3v3a2 2 0 0 1-2 2H3', 'M21 8h-3a2 2 0 0 1-2-2V3', 'M3 16h3a2 2 0 0 1 2 2v3', 'M16 21v-3a2 2 0 0 1 2-2h3'] },
	expand: { paths: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'] },
	dot: { paths: [circle(12, 12, 4)], fill: true },
	circle: { paths: [circle(12, 12, 8.5)] },
	circleDashed: { paths: ['M10.1 2.18a9.93 9.93 0 0 1 3.8 0', 'M17.6 3.71a9.95 9.95 0 0 1 2.69 2.7', 'M21.82 10.1a9.93 9.93 0 0 1 0 3.8', 'M20.29 17.6a9.95 9.95 0 0 1-2.7 2.69', 'M13.9 21.82a9.94 9.94 0 0 1-3.8 0', 'M6.4 20.29a9.95 9.95 0 0 1-2.69-2.7', 'M2.18 13.9a9.93 9.93 0 0 1 0-3.8', 'M3.71 6.4a9.95 9.95 0 0 1 2.7-2.69'] },
	send: { paths: ['M12 19V5', 'm5.5 11.5 6.5-6.5 6.5 6.5'] },
	queue: { paths: ['M3 5h12', 'M3 10h12', 'M3 15h8', 'm16 15 3 3 3-3', 'M19 9v9'] },
	snooze: { paths: [circle(12, 13, 8), 'M12 9v4l2 2', 'M5 3 2 6', 'm22 6-3-3'] },
	wand: { paths: ['m21.6 2.4-1.2-1.2a1.2 1.2 0 0 0-1.7 0L1.2 18.7a1.2 1.2 0 0 0 0 1.7l1.2 1.2a1.2 1.2 0 0 0 1.7 0L21.6 4.1a1.2 1.2 0 0 0 0-1.7Z', 'm14 7 3 3', 'M5 6v4', 'M19 14v4', 'M10 2v2', 'M7 8H3', 'M21 16h-4', 'M11 3H9'] },
	home: { paths: ['M3 10.5 12 3l9 7.5', 'M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5'] },
	palette: { paths: ['M12 2.5a9.5 9.5 0 0 0 0 19c1.2 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8h2.1a4.8 4.8 0 0 0 4.8-4.8c0-4.6-4.3-8.1-9.5-8.1Z', circle(7.5, 11, 1.2), circle(10.5, 7, 1.2), circle(15, 7.5, 1.2)] },
	plug: { paths: ['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v5a6 6 0 0 1-12 0V8Z'] },
} as const satisfies Record<string, IIconDef>;

export type IconName = keyof typeof ICONS;
