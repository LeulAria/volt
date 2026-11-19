/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { findHttpFlowStep, HTTP_FLOW_FILE_SUFFIX, HTTP_FLOW_FORMAT_GUIDE, httpFlowRunText, httpFlowStepsOf, IHttpFlow, IHttpFlowProblem, IHttpFlowStep, newHttpFlowStepId, parseHttpFlow, serializeHttpFlow } from '../../../../voltHttp/common/httpAutomation.js';
import { IVoltHttpAutomations } from '../../../../voltHttp/browser/voltHttpAutomations.js';
import { IHttpConfinement } from '../../../../voltHttp/browser/voltHttpService.js';
import { confinedReadRefusal, display, fail, IIdeCapabilityContext, IIdeCapabilityResult, num, ok, resolvePath, str } from './capability.js';

/** The ops of the `http` capability that work on automations (`*.volt-flow.json`). */
export const HTTP_AUTOMATION_OPS: readonly string[] = ['automation_list', 'automation_get', 'automation_save', 'automation_run', 'automation_delete'];

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A JSON value the agent sent as JSON or as a string holding JSON. */
function jsonArg(args: Readonly<Record<string, unknown>>, key: string): unknown {
	const value = args[key];
	if (typeof value !== 'string') {
		return value;
	}
	try {
		return JSON.parse(value);
	} catch (err) {
		throw new Error(`${key} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function problemLines(problems: readonly IHttpFlowProblem[]): string {
	return problems.map(problem => `- ${problem.severity}${problem.path ? ` at ${problem.path}` : ''}: ${problem.message}`).join('\n');
}

async function writeRefusal(ctx: IIdeCapabilityContext, uri: URI): Promise<string | undefined> {
	if (!ctx.confinement) {
		return undefined;
	}
	return ctx.confinement.writeRefusal ? ctx.confinement.writeRefusal(uri.fsPath) : `Volt cannot tell whether this sandboxed chat may write ${uri.fsPath}`;
}

/** The flow file an op names with `path` (a file, or a flow's name), or why there is none. */
async function flowUri(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext, automations: IVoltHttpAutomations, confined: IHttpConfinement | undefined, required: boolean): Promise<URI | undefined> {
	// automation_save's name is the flow's new name, not a way to find one.
	const raw = str(args, 'path') ?? (required ? str(args, 'name') : undefined);
	if (!raw) {
		if (required) {
			throw new Error('Say which automation with path (its .volt-flow.json file). automation_list shows them.');
		}
		return undefined;
	}
	const listed = await automations.list(ctx.root);
	const uri = resolvePath(ctx.root, raw);
	const match = listed.find(entry => uri && entry.uri.toString() === uri.toString())
		?? listed.find(entry => entry.name.toLowerCase() === raw.toLowerCase())
		?? (uri && !uri.path.endsWith(HTTP_FLOW_FILE_SUFFIX) ? listed.find(entry => entry.uri.toString() === URI.from({ ...uri, path: `${uri.path}${HTTP_FLOW_FILE_SUFFIX}` }).toString()) : undefined);
	const target = match?.uri ?? uri;
	if (!target) {
		throw new Error(`No automation at "${raw}".`);
	}
	if (confined && !await confined.readable(target)) {
		throw new Error(`This chat may not read ${raw}.`);
	}
	return target;
}

/** The steps the agent sent: a list, or one step. */
function stepsArg(args: Readonly<Record<string, unknown>>, key: string): IHttpFlowStep[] | undefined {
	const value = jsonArg(args, key);
	if (value === undefined || value === null) {
		return undefined;
	}
	const parsed = parseHttpFlow({ volt: 'flow', name: 'steps', steps: Array.isArray(value) ? value : [value] });
	if (!parsed.flow) {
		throw new Error(`${key}: ${parsed.error}`);
	}
	const unread = parsed.problems.filter(problem => problem.severity === 'error' || /Unknown step kind|must be an object/.test(problem.message));
	if (unread.length) {
		throw new Error(`${key} has steps that could not be read:\n${problemLines(unread)}`);
	}
	return parsed.flow.steps;
}

/** Steps added to a flow get ids no step there has (a step written by hand is `s1`, `s2`...). */
function freshIds(flow: IHttpFlow, steps: readonly IHttpFlowStep[]): void {
	const taken = new Set(httpFlowStepsOf(flow.steps).map(step => step.id));
	for (const step of httpFlowStepsOf(steps)) {
		if (taken.has(step.id)) {
			step.id = newHttpFlowStepId(taken);
		}
		taken.add(step.id);
	}
}

/**
 * The automation ops of the `ide` tool's `http` capability; undefined for any other op.
 * - automation_list: the project's flows.
 * - automation_get { path }: a flow's JSON and what is wrong with it.
 * - automation_save { path?, name?, flow? | steps? | add_steps? (+ after?, parent?) | replace_step? | remove_steps? }:
 *   writes a whole flow, or changes the steps of an existing one; validates; returns the file.
 * - automation_run { path, environment?, from_step?, only_step? }: runs it to the end and reports.
 * - automation_delete { path }: moves the file to the trash.
 */
export async function runHttpAutomationOp(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext, automations: IVoltHttpAutomations, confined: IHttpConfinement | undefined): Promise<IIdeCapabilityResult | undefined> {
	if (!HTTP_AUTOMATION_OPS.includes(op)) {
		return undefined;
	}
	try {
		switch (op) {
			case 'automation_list': {
				const listed = await automations.list(ctx.root);
				const visible = [];
				for (const entry of listed) {
					if (!confined || await confined.readable(entry.uri)) {
						visible.push(entry);
					}
				}
				if (!visible.length) {
					return ok(`The project has no automations yet. automation_save with a flow creates one.\n\n${HTTP_FLOW_FORMAT_GUIDE}`);
				}
				return ok(visible.map(entry => {
					const last = automations.historyOf(entry.uri).at(-1);
					return `${entry.name} - ${display(ctx.root, entry.uri)}${entry.detail ? ` (${entry.detail})` : ''}${entry.running ? ' [running]' : last ? ` [last run ${last.state}: ${last.passed}/${last.total} passed]` : ''}`;
				}).join('\n'));
			}
			case 'automation_get': {
				const uri = (await flowUri(args, ctx, automations, confined, true))!;
				const entry = await automations.load(uri);
				if (!entry) {
					return fail(`No automation at ${display(ctx.root, uri)}.`);
				}
				if (entry.error) {
					return fail(`${display(ctx.root, uri)} is not a flow that can be read: ${entry.error}`);
				}
				const problems = await automations.problems(uri, ctx.root, confined?.readable);
				return ok(`${display(ctx.root, uri)}\n${serializeHttpFlow(entry.flow)}${problems.length ? `\nProblems:\n${problemLines(problems)}` : '\nNo problems found.'}`);
			}
			case 'automation_save': {
				const uri = await flowUri(args, ctx, automations, confined, false);
				const whole = jsonArg(args, 'flow');
				let flow: IHttpFlow;
				let readProblems: readonly IHttpFlowProblem[] = [];
				const existing = uri ? await automations.load(uri) : undefined;
				if (whole !== undefined) {
					const parsed = parseHttpFlow(record(whole) && record(whole)!.volt === undefined ? { volt: 'flow', ...record(whole) } : whole, str(args, 'name') ?? (uri ? basename(uri).slice(0, -HTTP_FLOW_FILE_SUFFIX.length) : 'Automation'));
					if (!parsed.flow) {
						return fail(`Not saved: ${parsed.error}\n\n${HTTP_FLOW_FORMAT_GUIDE}`);
					}
					flow = parsed.flow;
					readProblems = parsed.problems;
					if (str(args, 'name')) {
						flow.name = str(args, 'name')!;
					}
				} else {
					if (!existing || existing.error) {
						return fail(existing?.error
							? `Not saved: ${display(ctx.root, existing.uri)} is not a flow that can be read (${existing.error}). Send the whole flow as flow to replace it.`
							: `Not saved: give flow (the whole flow file as JSON) to create an automation, or path to change one.\n\n${HTTP_FLOW_FORMAT_GUIDE}`);
					}
					flow = structuredClone(existing.flow);
					const steps = stepsArg(args, 'steps');
					const add = stepsArg(args, 'add_steps');
					const replace = stepsArg(args, 'replace_step');
					const remove = Array.isArray(args.remove_steps) ? args.remove_steps.filter((id): id is string => typeof id === 'string') : typeof args.remove_steps === 'string' ? [args.remove_steps] : [];
					if (!steps && !add && !replace && !remove.length && !str(args, 'name')) {
						return fail('Nothing to change: give flow, steps, add_steps, replace_step or remove_steps.');
					}
					if (str(args, 'name')) {
						flow.name = str(args, 'name')!;
					}
					if (steps) {
						flow.steps = steps;
					}
					for (const id of remove) {
						const found = findHttpFlowStep(flow, id);
						if (!found) {
							return fail(`Not saved: no step with the id ${id}. automation_get shows the ids.`);
						}
						found.siblings.splice(found.index, 1);
					}
					if (replace) {
						for (const step of replace) {
							const found = findHttpFlowStep(flow, step.id);
							if (!found) {
								return fail(`Not saved: replace_step names the id ${step.id}, which no step has. automation_get shows the ids; add_steps adds new ones.`);
							}
							found.siblings[found.index] = step;
						}
					}
					if (add) {
						freshIds(flow, add);
						const after = str(args, 'after');
						const parent = str(args, 'parent');
						if (after) {
							const found = findHttpFlowStep(flow, after);
							if (!found) {
								return fail(`Not saved: no step with the id ${after} to add after.`);
							}
							found.siblings.splice(found.index + 1, 0, ...add);
						} else if (parent) {
							const found = findHttpFlowStep(flow, parent);
							if (!found || !('steps' in found.step)) {
								return fail(`Not saved: ${parent} is not a group, condition or repeat step to add into.`);
							}
							found.step.steps.push(...add);
						} else {
							flow.steps.push(...add);
						}
					}
				}
				// A new file is always a flow file, whatever the path given ends with.
				const target = uri && !existing && !uri.path.endsWith(HTTP_FLOW_FILE_SUFFIX) ? URI.from({ ...uri, path: `${uri.path}${HTTP_FLOW_FILE_SUFFIX}` }) : uri;
				if (target) {
					const refused = await writeRefusal(ctx, target);
					if (refused) {
						return fail(`Not saved: ${refused}.`);
					}
				} else if (ctx.confinement) {
					const refused = ctx.root ? await writeRefusal(ctx, ctx.root) : 'this chat has no project folder';
					if (refused) {
						return fail(`Not saved: ${refused}.`);
					}
				}
				const saved = await automations.write(ctx.root, flow, target);
				const problems = [...readProblems, ...await automations.problems(saved, ctx.root, confined?.readable)];
				const steps = httpFlowStepsOf(flow.steps).length;
				return ok(`Saved ${flow.name} (${steps} step${steps === 1 ? '' : 's'}) to ${display(ctx.root, saved)}.${problems.length ? `\nProblems to fix before it runs cleanly:\n${problemLines(problems)}` : ' No problems found.'}`);
			}
			case 'automation_run': {
				const uri = (await flowUri(args, ctx, automations, confined, true))!;
				const fromStep = str(args, 'from_step');
				const onlyStep = str(args, 'only_step');
				const run = await automations.run(uri, {
					...(ctx.root ? { root: ctx.root } : {}),
					...(str(args, 'environment') ? { environment: str(args, 'environment')! } : {}),
					...(confined ? { confined } : {}),
					token: ctx.token,
					...(fromStep ? { fromStepId: fromStep } : {}),
					...(onlyStep ? { onlyStepId: onlyStep } : {}),
				});
				const text = httpFlowRunText(run, { maxValue: num(args, 'max_value') ?? 300 });
				return run.state === 'error' ? fail(text) : ok(text);
			}
			case 'automation_delete': {
				const uri = (await flowUri(args, ctx, automations, confined, true))!;
				if (await confinedReadRefusal(ctx, uri)) {
					return fail(`This chat may not read ${display(ctx.root, uri)}.`);
				}
				const refused = await writeRefusal(ctx, uri);
				if (refused) {
					return fail(`Not deleted: ${refused}.`);
				}
				await automations.remove(uri);
				return ok(`Deleted ${display(ctx.root, uri)} (moved to the trash).`);
			}
		}
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
	return undefined;
}
