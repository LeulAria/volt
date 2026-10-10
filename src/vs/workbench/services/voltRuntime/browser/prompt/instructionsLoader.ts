/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { IInstructionDoc, IRuleDoc, ISubagentDoc, ruleFromFile, skillFromFile, subagentFromFile } from '../../common/harness/instructions.js';

export interface IInstructionsSnapshot {
	readonly skills: readonly IInstructionDoc[];
	readonly rules: readonly IRuleDoc[];
	/** Subagents defined in files; the task tool can start them by name. */
	readonly subagents?: readonly ISubagentDoc[];
	/** Skill folders, readable by read_file even though they sit outside the workspace. */
	readonly readRoots: readonly URI[];
}

/** Volt's own folder first, then the layouts other agents use, so an existing setup works as is. */
const WORKSPACE_SKILL_DIRS = ['.volt/skills', '.agents/skills', '.claude/skills', '.cursor/skills', '.codex/skills'];
const HOME_SKILL_DIRS = ['.volt/skills', '.agents/skills', '.claude/skills', '.cursor/skills', '.codex/skills'];
const RULE_DIRS = ['.cursor/rules', '.volt/rules'];
const SUBAGENT_DIRS = ['.volt/agents', '.agents/agents', '.claude/agents', '.cursor/agents', '.codex/agents'];
const MAX_DOC_CHARS = 60_000;

/** Workspace skills win over personal ones with the same name. */
export async function loadInstructions(fileService: IFileService, root: URI | undefined, home: URI | undefined): Promise<IInstructionsSnapshot> {
	const plugins = home ? await pluginRoots(fileService, home) : [];
	const skillDirs = [
		...(root ? WORKSPACE_SKILL_DIRS.map(dir => joinPath(root, dir)) : []),
		...(home ? HOME_SKILL_DIRS.map(dir => joinPath(home, dir)) : []),
		...plugins.map(plugin => joinPath(plugin, 'skills')),
	];
	const agentDirs = [
		...(root ? SUBAGENT_DIRS.map(dir => joinPath(root, dir)) : []),
		...(home ? SUBAGENT_DIRS.map(dir => joinPath(home, dir)) : []),
		...plugins.map(plugin => joinPath(plugin, 'agents')),
	];
	const [skillLists, ruleLists, agentLists] = await Promise.all([
		Promise.all(skillDirs.map(dir => loadSkills(fileService, dir))),
		Promise.all(root ? RULE_DIRS.map(dir => loadRules(fileService, joinPath(root, dir), 0)) : []),
		Promise.all(agentDirs.map(dir => loadSubagents(fileService, dir))),
	]);
	const skills: IInstructionDoc[] = [];
	const names = new Set<string>();
	for (const skill of skillLists.flat()) {
		const key = skill.name.toLowerCase();
		if (!names.has(key)) {
			names.add(key);
			skills.push(skill);
		}
	}
	const readRoots = skillDirs.filter((_, index) => skillLists[index].length > 0);
	// The nearest definition of a name wins: the project's, then the user's, then a plugin's.
	const subagents: ISubagentDoc[] = [];
	const agentNames = new Set<string>();
	for (const agent of agentLists.flat()) {
		const key = agent.name.toLowerCase();
		if (!agentNames.has(key)) {
			agentNames.add(key);
			subagents.push(agent);
		}
	}
	return { skills, rules: ruleLists.flat(), subagents, readRoots };
}

async function loadSkills(fileService: IFileService, dir: URI, depth = 0): Promise<IInstructionDoc[]> {
	const stat = await resolve(fileService, dir);
	if (!stat?.children) {
		return [];
	}
	const loaded = await Promise.all(stat.children.filter(child => child.isDirectory && !child.name.startsWith('.')).map(async (child): Promise<IInstructionDoc[]> => {
		for (const name of ['SKILL.md', 'skill.md', 'Skill.md']) {
			const file = joinPath(child.resource, name);
			const text = await readText(fileService, file);
			if (text) {
				const skill = skillFromFile(text, child.name, file.toString(), child.resource.toString());
				return skill ? [skill] : [];
			}
		}
		// One level of grouping folders: `skills/<group>/<name>/SKILL.md`.
		return depth < 1 ? loadSkills(fileService, child.resource, depth + 1) : [];
	}));
	return loaded.flat();
}

async function loadSubagents(fileService: IFileService, dir: URI): Promise<ISubagentDoc[]> {
	const stat = await resolve(fileService, dir);
	if (!stat?.children) {
		return [];
	}
	const loaded = await Promise.all(stat.children
		.filter(child => !child.isDirectory && /\.md$/i.test(child.name) && !/^readme\.md$/i.test(child.name))
		.map(async child => {
			const text = await readText(fileService, child.resource);
			return text ? subagentFromFile(text, child.name, child.resource.toString()) : undefined;
		}));
	return loaded.filter((agent): agent is ISubagentDoc => !!agent);
}

/**
 * Folders of installed plugins: Claude Code's (enabled ones, from its install list), Volt's own
 * (`~/.volt/plugins/<name>`), and Cursor's newest finished download of each plugin.
 */
async function pluginRoots(fileService: IFileService, home: URI): Promise<URI[]> {
	const dirs: URI[] = [];
	const [installed, settings] = await Promise.all([
		readJson(fileService, joinPath(home, '.claude', 'plugins', 'installed_plugins.json')),
		readJson(fileService, joinPath(home, '.claude', 'settings.json')),
	]);
	const enabled = ((settings as { enabledPlugins?: Record<string, unknown> } | undefined)?.enabledPlugins ?? {}) as Record<string, unknown>;
	const plugins = (installed as { plugins?: Record<string, unknown> } | undefined)?.plugins ?? {};
	for (const [key, entries] of Object.entries(plugins)) {
		if (enabled[key] === false || !Array.isArray(entries)) {
			continue;
		}
		const entry = entries.find(candidate => (candidate as { scope?: unknown }).scope !== 'project') as { installPath?: unknown } | undefined;
		if (typeof entry?.installPath === 'string') {
			dirs.push(URI.file(entry.installPath));
		}
	}
	const volt = await resolve(fileService, joinPath(home, '.volt', 'plugins'));
	for (const plugin of volt?.children ?? []) {
		if (plugin.isDirectory) {
			dirs.push(plugin.resource);
		}
	}
	const cursorCache = await resolve(fileService, joinPath(home, '.cursor', 'plugins', 'cache'));
	for (const marketplace of cursorCache?.children ?? []) {
		const named = marketplace.isDirectory ? await resolve(fileService, marketplace.resource) : undefined;
		for (const plugin of named?.children ?? []) {
			if (!plugin.isDirectory) {
				continue;
			}
			const versions = await resolve(fileService, plugin.resource, true);
			const newest = (versions?.children ?? []).filter(child => child.isDirectory).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))[0];
			if (newest) {
				dirs.push(newest.resource);
			}
		}
	}
	return dirs;
}

async function readJson(fileService: IFileService, uri: URI): Promise<unknown> {
	const text = await readText(fileService, uri);
	if (!text) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

async function loadRules(fileService: IFileService, dir: URI, depth: number): Promise<IRuleDoc[]> {
	const stat = await resolve(fileService, dir);
	if (!stat?.children) {
		return [];
	}
	const rules: IRuleDoc[] = [];
	for (const child of [...stat.children].sort((a, b) => a.name.localeCompare(b.name))) {
		if (child.isDirectory) {
			if (depth < 2) {
				rules.push(...await loadRules(fileService, child.resource, depth + 1));
			}
			continue;
		}
		if (!/\.(mdc|md|txt)$/i.test(child.name)) {
			continue;
		}
		const text = await readText(fileService, child.resource);
		const rule = text ? ruleFromFile(text, child.name, child.resource.toString()) : undefined;
		if (rule) {
			rules.push(rule);
		}
	}
	return rules;
}

async function resolve(fileService: IFileService, uri: URI, metadata = false): Promise<IFileStat | undefined> {
	try {
		return await fileService.resolve(uri, { resolveMetadata: metadata });
	} catch {
		return undefined;
	}
}

async function readText(fileService: IFileService, uri: URI): Promise<string | undefined> {
	try {
		const text = (await fileService.readFile(uri)).value.toString();
		return text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}\n[truncated]` : text;
	} catch {
		return undefined;
	}
}
