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

/** Skill, rule, subagent and plugin folders of any layout above, and the files that enable plugins. */
const INSTRUCTION_PATH = /\/\.(?:volt|agents|claude|cursor|codex)(?:\/(?:skills|rules|agents|plugins)(?:\/|$)|$)|\/\.claude\/settings\.json$/i;

/** Whether a change to this file or folder can change what {@link loadInstructions} returns. */
export function affectsInstructions(resource: URI): boolean {
	return INSTRUCTION_PATH.test(resource.path);
}

/** Workspace skills win over personal ones with the same name. */
export async function loadInstructions(fileService: IFileService, root: URI | undefined, home: URI | undefined): Promise<IInstructionsSnapshot> {
	const ownSkillDirs = [
		...(root ? WORKSPACE_SKILL_DIRS.map(dir => joinPath(root, dir)) : []),
		...(home ? HOME_SKILL_DIRS.map(dir => joinPath(home, dir)) : []),
	];
	const ownAgentDirs = [
		...(root ? SUBAGENT_DIRS.map(dir => joinPath(root, dir)) : []),
		...(home ? SUBAGENT_DIRS.map(dir => joinPath(home, dir)) : []),
	];
	// The workspace's and the user's folders do not wait for the plugin scan; plugins still come last.
	const fromPlugins = (home ? pluginRoots(fileService, home) : Promise.resolve([])).then(async plugins => {
		const skillDirs = plugins.map(plugin => joinPath(plugin, 'skills'));
		const agentDirs = plugins.map(plugin => joinPath(plugin, 'agents'));
		const [skills, agents] = await Promise.all([
			Promise.all(skillDirs.map(dir => loadSkills(fileService, dir))),
			Promise.all(agentDirs.map(dir => loadSubagents(fileService, dir))),
		]);
		return { skillDirs, skills, agents };
	});
	const [ownSkills, ruleLists, ownAgents, plugin] = await Promise.all([
		Promise.all(ownSkillDirs.map(dir => loadSkills(fileService, dir))),
		Promise.all(root ? RULE_DIRS.map(dir => loadRules(fileService, joinPath(root, dir), 0)) : []),
		Promise.all(ownAgentDirs.map(dir => loadSubagents(fileService, dir))),
		fromPlugins,
	]);
	const skillDirs = [...ownSkillDirs, ...plugin.skillDirs];
	const skillLists = [...ownSkills, ...plugin.skills];
	const agentLists = [...ownAgents, ...plugin.agents];
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
	// Every source is read at once; the order of the result stays Claude's, Volt's, Cursor's.
	const [installed, settings, volt, cursor] = await Promise.all([
		readJson(fileService, joinPath(home, '.claude', 'plugins', 'installed_plugins.json')),
		readJson(fileService, joinPath(home, '.claude', 'settings.json')),
		resolve(fileService, joinPath(home, '.volt', 'plugins')),
		cursorPluginRoots(fileService, home),
	]);
	const dirs: URI[] = [];
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
	for (const plugin of volt?.children ?? []) {
		if (plugin.isDirectory) {
			dirs.push(plugin.resource);
		}
	}
	dirs.push(...cursor);
	return dirs;
}

/** The newest finished download of each Cursor plugin, every marketplace and plugin read in parallel. */
async function cursorPluginRoots(fileService: IFileService, home: URI): Promise<URI[]> {
	const cache = await resolve(fileService, joinPath(home, '.cursor', 'plugins', 'cache'));
	const marketplaces = await Promise.all((cache?.children ?? []).filter(child => child.isDirectory).map(async marketplace => {
		const named = await resolve(fileService, marketplace.resource);
		return Promise.all((named?.children ?? []).filter(plugin => plugin.isDirectory).map(async plugin => {
			const versions = await resolve(fileService, plugin.resource, true);
			return (versions?.children ?? []).filter(child => child.isDirectory).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))[0]?.resource;
		}));
	}));
	return marketplaces.flat().filter((dir): dir is URI => !!dir);
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
	// Read in parallel; the result keeps the sorted order.
	const loaded = await Promise.all([...stat.children].sort((a, b) => a.name.localeCompare(b.name)).map(async (child): Promise<IRuleDoc[]> => {
		if (child.isDirectory) {
			return depth < 2 ? loadRules(fileService, child.resource, depth + 1) : [];
		}
		if (!/\.(mdc|md|txt)$/i.test(child.name)) {
			return [];
		}
		const text = await readText(fileService, child.resource);
		const rule = text ? ruleFromFile(text, child.name, child.resource.toString()) : undefined;
		return rule ? [rule] : [];
	}));
	return loaded.flat();
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
