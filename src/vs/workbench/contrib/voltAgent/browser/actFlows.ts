/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { formatActScript, parseActScript } from '../../../services/voltRuntime/common/tools/actScript.js';
import { IActStep, MAX_ACT_STEPS, parseActSteps } from '../../../services/voltRuntime/common/tools/pageModel.js';

/**
 * Saved flows: a step script that worked, kept as `.volt/flows/<name>.flow` in the project, so the
 * agent can re-run a whole verified flow (sign in, checkout, the settings page) with one tiny call
 * after every edit, and the team can commit them like tests. `${name}` placeholders take `vars`.
 */

export const FLOWS_FOLDER = '.volt/flows';
const NAME_RE = /^[\w.-]{1,64}$/;
const MAX_DEPTH = 3;

export interface IFlowStore {
	read(name: string): Promise<string | undefined>;
	write(name: string, script: string): Promise<URI>;
	list(): Promise<string[]>;
}

export function fileFlowStore(fileService: IFileService, root: URI): IFlowStore {
	const folder = joinPath(root, FLOWS_FOLDER);
	const file = (name: string) => joinPath(folder, `${name}.flow`);
	return {
		async read(name) {
			if (!NAME_RE.test(name)) {
				return undefined;
			}
			try {
				return (await fileService.readFile(file(name))).value.toString();
			} catch {
				return undefined;
			}
		},
		async write(name, script) {
			const target = file(name);
			await fileService.writeFile(target, VSBuffer.fromString(`${script.trim()}\n`));
			return target;
		},
		async list() {
			try {
				const stat = await fileService.resolve(folder);
				return (stat.children ?? []).filter(child => !child.isDirectory && child.name.endsWith('.flow')).map(child => child.name.slice(0, -'.flow'.length)).sort();
			} catch {
				return [];
			}
		},
	};
}

/** One unit of work: the steps of an inline run, or of one saved flow when several are run. */
export interface IActPlan {
	readonly label?: string;
	readonly steps: readonly IActStep[];
}

export interface IActInput {
	readonly plans: readonly IActPlan[];
	/** Save the inline run as this flow when it passes. */
	readonly save?: { readonly name: string; readonly script: string };
}

function stringVars(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
}

/** Replaces `flow` steps with the saved flow's steps (flows may run flows, a few levels deep). */
async function expand(steps: readonly IActStep[], store: IFlowStore | undefined, vars: Readonly<Record<string, string>> | undefined, depth: number): Promise<IActStep[] | string> {
	const out: IActStep[] = [];
	for (const step of steps) {
		if (step.action !== 'flow') {
			out.push(step);
			continue;
		}
		if (!store) {
			return 'Saved flows need an open project folder.';
		}
		if (depth >= MAX_DEPTH) {
			return `flow ${step.flow} nests flows more than ${MAX_DEPTH} deep.`;
		}
		const script = await store.read(step.flow!);
		if (script === undefined) {
			const known = await store.list();
			return `There is no saved flow ${JSON.stringify(step.flow)}${known.length ? ` (saved flows: ${known.join(', ')})` : ` (save one with "save": "${step.flow}")`}.`;
		}
		const parsed = parseActScript(script, { ...vars, ...step.vars });
		if ('error' in parsed) {
			return `flow ${step.flow}: ${parsed.error}`;
		}
		const inner = await expand(parsed.steps, store, { ...vars, ...step.vars }, depth + 1);
		if (typeof inner === 'string') {
			return inner;
		}
		out.push(...inner.map(item => step.optional ? { ...item, optional: true } : item));
	}
	if (out.length > MAX_ACT_STEPS * 4) {
		return `That expands to ${out.length} steps; run fewer flows per call.`;
	}
	return out;
}

/**
 * What an act call asks to run: `steps` (JSON), `script` (step script), or `run` (one saved flow
 * or several, each reported on its own), with `vars` for `${name}` placeholders and `save` to keep
 * a passing inline run as a flow.
 */
export async function resolveActInput(args: Record<string, unknown>, store: IFlowStore | undefined, tool: string): Promise<IActInput | { readonly error: string }> {
	const vars = stringVars(args.vars);
	const run = typeof args.run === 'string' ? [args.run] : Array.isArray(args.run) ? args.run.map(String) : undefined;
	if (run?.length) {
		const plans: IActPlan[] = [];
		for (const name of run) {
			const steps = await expand([{ action: 'flow', flow: name }], store, vars, 0);
			if (typeof steps === 'string') {
				return { error: steps };
			}
			plans.push({ label: name, steps });
		}
		return { plans };
	}
	let steps: readonly IActStep[];
	let script: string | undefined;
	if (typeof args.script === 'string' && args.script.trim()) {
		const parsed = parseActScript(args.script, vars);
		if ('error' in parsed) {
			return { error: `${tool} script: ${parsed.error}` };
		}
		steps = parsed.steps;
		script = args.script;
	} else {
		const parsed = parseActSteps(args.steps);
		if ('error' in parsed) {
			return { error: parsed.error.replace('browser_act', tool).replace('`steps`', '`script` (one step per line, e.g. "click button \\"Save\\"") or `steps`') };
		}
		steps = parsed.steps;
	}
	const expanded = await expand(steps, store, vars, 0);
	if (typeof expanded === 'string') {
		return { error: expanded };
	}
	const name = typeof args.save === 'string' ? args.save.trim() : undefined;
	if (name !== undefined && !NAME_RE.test(name)) {
		return { error: 'save needs a flow name of letters, digits, ".", "-" or "_" (e.g. "sign-in").' };
	}
	return { plans: [{ steps: expanded }], save: name ? { name, script: script ?? formatActScript(steps) } : undefined };
}
