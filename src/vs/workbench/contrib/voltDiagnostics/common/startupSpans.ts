/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltTracer } from '../../../../platform/voltDiagnostics/common/tracer.js';
import { VoltAttributes } from '../../../../platform/voltDiagnostics/common/voltDiagnostics.js';

/** Startup phases as span name, start mark, end mark (the pairs the timer service reports). */
const PHASES: readonly (readonly [string, string, string])[] = [
	['main.app_ready', 'code/didStartMain', 'code/mainAppReady'],
	['main.load_main_bundle', 'code/willLoadMainBundle', 'code/didLoadMainBundle'],
	['main.start_main_server', 'code/willStartMainServer', 'code/didStartMainServer'],
	['main.create_window', 'code/willCreateCodeWindow', 'code/didCreateCodeWindow'],
	['main.restore_window_state', 'code/willRestoreCodeWindowState', 'code/didRestoreCodeWindowState'],
	['main.create_browser_window', 'code/willCreateCodeBrowserWindow', 'code/didCreateCodeBrowserWindow'],
	['window.load', 'code/willOpenNewWindow', 'code/willLoadWorkbenchMain'],
	['window.load_workbench_main', 'code/willLoadWorkbenchMain', 'code/didLoadWorkbenchMain'],
	['window.wait_for_config', 'code/willWaitForWindowConfig', 'code/didWaitForWindowConfig'],
	['window.init_storage', 'code/willInitStorage', 'code/didInitStorage'],
	['window.connect_shared_process', 'code/willConnectSharedProcess', 'code/didConnectSharedProcess'],
	['window.init_workspace', 'code/willInitWorkspaceService', 'code/didInitWorkspaceService'],
	['window.init_user_data', 'code/willInitRequiredUserData', 'code/didInitRequiredUserData'],
	['workbench.start', 'code/willStartWorkbench', 'code/didStartWorkbench'],
	['workbench.contributions', 'code/willCreateWorkbenchContributions/1', 'code/didCreateWorkbenchContributions/2'],
	['workbench.restore_editors', 'code/willRestoreEditors', 'code/didRestoreEditors'],
	['workbench.restore_sidebar', 'code/willRestoreViewlet', 'code/didRestoreViewlet'],
	['workbench.restore_auxiliary_bar', 'code/willRestoreAuxiliaryBar', 'code/didRestoreAuxiliaryBar'],
	['workbench.restore_panel', 'code/willRestorePanel', 'code/didRestorePanel'],
	['extensions.load', 'code/willLoadExtensions', 'code/didLoadExtensions'],
];

const LIFECYCLE_PREFIX = 'code/LifecyclePhase/';

/** First time of each mark across sources (main, renderer, ...). Marks are epoch milliseconds. */
export function indexMarks(sources: readonly (readonly [string, readonly { readonly name: string; readonly startTime: number }[]])[]): Map<string, number> {
	const marks = new Map<string, number>();
	for (const [, entries] of sources) {
		for (const mark of entries) {
			if (!marks.has(mark.name)) {
				marks.set(mark.name, mark.startTime);
			}
		}
	}
	return marks;
}

/**
 * One `window.startup` trace: the root runs from the first mark of this startup (main start on a
 * cold start, the window open request on a reload or new window) to the last phase that finished,
 * with a child per phase whose marks both exist and lifecycle phases as events.
 */
export function recordStartupTrace(tracer: VoltTracer, marks: ReadonlyMap<string, number>, initialStartup: boolean, attributes: VoltAttributes): number {
	const start = (initialStartup ? marks.get('code/didStartMain') : undefined) ?? marks.get('code/willOpenNewWindow') ?? marks.get('code/timeOrigin');
	if (start === undefined) {
		return 0;
	}
	const phases: { name: string; start: number; end: number }[] = [];
	for (const [name, from, to] of PHASES) {
		const phaseStart = marks.get(from);
		const phaseEnd = marks.get(to);
		// Main-process phases from an earlier window's startup are not part of this one.
		if (phaseStart === undefined || phaseEnd === undefined || phaseEnd < phaseStart || phaseStart < start) {
			continue;
		}
		phases.push({ name, start: phaseStart, end: phaseEnd });
	}
	const lifecycle = [...marks].filter(([name, time]) => name.startsWith(LIFECYCLE_PREFIX) && time >= start);
	const end = Math.max(start, ...phases.map(phase => phase.end), ...lifecycle.map(([, time]) => time));
	const root = tracer.startSpan('window.startup', { startTime: start, attributes: { ...attributes, 'volt.startup.initial': initialStartup, 'volt.startup.duration_ms': Math.round(end - start) } });
	for (const [name, time] of lifecycle) {
		root.addEvent(`lifecycle.${name.slice(LIFECYCLE_PREFIX.length)}`, undefined, time);
	}
	for (const phase of phases) {
		tracer.recordSpan(phase.name, phase.start, phase.end, { parent: root });
	}
	root.end(end);
	return phases.length;
}
