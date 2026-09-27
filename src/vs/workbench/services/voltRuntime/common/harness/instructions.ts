/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { match } from '../../../../../base/common/glob.js';

/**
 * Skills and rules, loaded progressively so a two-word question does not pay for every playbook:
 *
 * - a skill (`SKILL.md`) is listed by name and description; its body loads on request;
 * - a rule with `alwaysApply: true` (or no frontmatter) is part of every prompt;
 * - a rule with `globs` is attached the first time the agent touches a matching file;
 * - a rule with only a `description` is listed like a skill and loaded on request.
 */

export interface IInstructionDoc {
	readonly name: string;
	readonly description: string;
	readonly body: string;
	/** Where it came from, as a URI string. */
	readonly source: string;
	/** Folder whose other files the skill may reference. */
	readonly folder?: string;
}

export interface IRuleDoc extends IInstructionDoc {
	readonly always: boolean;
	readonly globs: readonly string[];
}

export interface IFrontmatter {
	readonly fields: Record<string, string | string[] | boolean>;
	readonly body: string;
}

/** Enough YAML for skill and rule headers: scalars, booleans, inline and dash lists. */
export function parseFrontmatter(text: string): IFrontmatter {
	const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
	const head = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
	if (!head) {
		return { fields: {}, body: normalized.trim() };
	}
	const fields: Record<string, string | string[] | boolean> = {};
	let listKey: string | undefined;
	for (const line of head[1].split('\n')) {
		const item = /^\s+-\s*(.*)$/.exec(line);
		if (item && listKey) {
			const list = Array.isArray(fields[listKey]) ? fields[listKey] as string[] : [];
			list.push(unquote(item[1]));
			fields[listKey] = list;
			continue;
		}
		const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!pair) {
			continue;
		}
		const key = pair[1];
		const value = pair[2].trim();
		listKey = value ? undefined : key;
		if (!value) {
			continue;
		}
		if (value === 'true' || value === 'false') {
			fields[key] = value === 'true';
		} else if (value.startsWith('[') && value.endsWith(']')) {
			fields[key] = value.slice(1, -1).split(',').map(part => unquote(part.trim())).filter(Boolean);
		} else {
			fields[key] = unquote(value);
		}
	}
	return { fields, body: normalized.slice(head[0].length).trim() };
}

function unquote(value: string): string {
	return value.replace(/^(['"])(.*)\1$/, '$2');
}

export function skillFromFile(text: string, folderName: string, source: string, folder: string): IInstructionDoc | undefined {
	const { fields, body } = parseFrontmatter(text);
	const name = typeof fields.name === 'string' && fields.name.trim() ? fields.name.trim() : folderName;
	const description = typeof fields.description === 'string' ? fields.description.trim() : firstSentence(body);
	return body ? { name, description, body, source, folder } : undefined;
}

export function ruleFromFile(text: string, fileName: string, source: string): IRuleDoc | undefined {
	const { fields, body } = parseFrontmatter(text);
	if (!body) {
		return undefined;
	}
	const globsField = fields.globs;
	const globs = (Array.isArray(globsField) ? globsField : typeof globsField === 'string' ? globsField.split(',') : [])
		.map(glob => glob.trim())
		.filter(Boolean);
	const description = typeof fields.description === 'string' ? fields.description.trim() : '';
	const hasFrontmatter = Object.keys(fields).length > 0;
	const always = fields.alwaysApply === true || (!hasFrontmatter);
	return { name: fileName.replace(/\.(mdc|md|txt)$/i, ''), description, body, source, always, globs };
}

/** Rules whose globs match `relativePath`, joined for injection next to a tool result. */
export function rulesForPath(rules: readonly IRuleDoc[], relativePath: string, budget = 6_000): string | undefined {
	const path = relativePath.replace(/\\/g, '/');
	const hits = rules.filter(rule => !rule.always && rule.globs.some(glob => match(glob.includes('/') || glob.startsWith('**') ? glob : `**/${glob}`, path)));
	if (!hits.length) {
		return undefined;
	}
	const text = hits.map(rule => `<rule name="${rule.name}" applies_to="${rule.globs.join(', ')}">\n${rule.body}\n</rule>`).join('\n');
	return `Project rules for ${path}:\n${text.length > budget ? `${text.slice(0, budget)}\n[rules truncated]` : text}`;
}

/** Index of loadable skills and description-only rules for the system prompt. */
export function instructionsIndex(skills: readonly IInstructionDoc[], rules: readonly IRuleDoc[]): string | undefined {
	const requested = rules.filter(rule => !rule.always && !rule.globs.length && rule.description);
	const entries = [...skills, ...requested].slice(0, 60);
	if (!entries.length) {
		return undefined;
	}
	const lines = entries.map(entry => `- ${entry.name}: ${entry.description.slice(0, 200)}`);
	return `<skills>\nLoad one with the skill tool when the task matches its description, then follow it.\n${lines.join('\n')}\n</skills>`;
}

/** Always-on rules, bounded, for the system prompt. */
export function alwaysRules(rules: readonly IRuleDoc[], budget = 12_000): string | undefined {
	const always = rules.filter(rule => rule.always);
	if (!always.length) {
		return undefined;
	}
	const text = always.map(rule => `<rule name="${rule.name}">\n${rule.body}\n</rule>`).join('\n');
	return `<rules>\n${text.length > budget ? `${text.slice(0, budget)}\n[rules truncated]` : text}\n</rules>`;
}

export function findInstruction(name: string, skills: readonly IInstructionDoc[], rules: readonly IRuleDoc[]): IInstructionDoc | undefined {
	const key = name.trim().toLowerCase();
	return skills.find(skill => skill.name.toLowerCase() === key)
		?? rules.find(rule => rule.name.toLowerCase() === key)
		?? skills.find(skill => skill.name.toLowerCase().includes(key))
		?? rules.find(rule => rule.name.toLowerCase().includes(key));
}

function firstSentence(body: string): string {
	const line = body.split('\n').find(candidate => candidate.trim() && !candidate.startsWith('#'))?.trim() ?? '';
	return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}
