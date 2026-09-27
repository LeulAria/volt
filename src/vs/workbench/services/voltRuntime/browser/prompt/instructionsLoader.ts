/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { IInstructionDoc, IRuleDoc, ruleFromFile, skillFromFile } from '../../common/harness/instructions.js';

export interface IInstructionsSnapshot {
	readonly skills: readonly IInstructionDoc[];
	readonly rules: readonly IRuleDoc[];
	/** Skill folders, readable by read_file even though they sit outside the workspace. */
	readonly readRoots: readonly URI[];
}

const WORKSPACE_SKILL_DIRS = ['.volt/skills', '.claude/skills', '.agents/skills'];
const HOME_SKILL_DIRS = ['.volt/skills', '.claude/skills'];
const RULE_DIRS = ['.cursor/rules', '.volt/rules'];
const MAX_DOC_CHARS = 60_000;

/** Workspace skills win over personal ones with the same name. */
export async function loadInstructions(fileService: IFileService, root: URI | undefined, home: URI | undefined): Promise<IInstructionsSnapshot> {
	const skillDirs = [
		...(root ? WORKSPACE_SKILL_DIRS.map(dir => joinPath(root, dir)) : []),
		...(home ? HOME_SKILL_DIRS.map(dir => joinPath(home, dir)) : []),
	];
	const [skillLists, ruleLists] = await Promise.all([
		Promise.all(skillDirs.map(dir => loadSkills(fileService, dir))),
		Promise.all(root ? RULE_DIRS.map(dir => loadRules(fileService, joinPath(root, dir), 0)) : []),
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
	return { skills, rules: ruleLists.flat(), readRoots };
}

async function loadSkills(fileService: IFileService, dir: URI): Promise<IInstructionDoc[]> {
	const stat = await resolve(fileService, dir);
	if (!stat?.children) {
		return [];
	}
	const loaded = await Promise.all(stat.children.filter(child => child.isDirectory).map(async child => {
		for (const name of ['SKILL.md', 'skill.md', 'Skill.md']) {
			const file = joinPath(child.resource, name);
			const text = await readText(fileService, file);
			if (text) {
				return skillFromFile(text, child.name, file.toString(), child.resource.toString());
			}
		}
		return undefined;
	}));
	return loaded.filter((skill): skill is IInstructionDoc => !!skill);
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

async function resolve(fileService: IFileService, uri: URI): Promise<IFileStat | undefined> {
	try {
		return await fileService.resolve(uri);
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
