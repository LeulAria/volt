/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Progressive skills (pi + DeepSeek). The model sees name + description until
 * it asks to load one. Shipping every skill body in the system prompt is how
 * you burn the cache on a "what is 2+2" turn.
 */

export interface ISkillMeta {
	readonly name: string;
	readonly description: string;
	readonly source: string;
}

export interface ISkill extends ISkillMeta {
	readonly body: string;
}

export class SkillCatalog {

	private readonly metas = new Map<string, ISkillMeta>();
	private readonly bodies = new Map<string, string>();

	register(skill: ISkill): void {
		const name = skill.name.trim();
		if (!name) {
			return;
		}
		this.metas.set(name, { name, description: skill.description.trim(), source: skill.source });
		this.bodies.set(name, skill.body);
	}

	list(): readonly ISkillMeta[] {
		return [...this.metas.values()];
	}

	load(name: string): ISkill | undefined {
		const meta = this.metas.get(name);
		const body = this.bodies.get(name);
		return meta && body !== undefined ? { ...meta, body } : undefined;
	}

	promptBlock(): string | undefined {
		const listed = this.list();
		if (!listed.length) {
			return undefined;
		}
		return ['Skills (name only - load one before following it):', ...listed.map(skill => `- ${skill.name}: ${skill.description}`)].join('\n');
	}
}
