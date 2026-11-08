/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import { HOST_TOOL_SANDBOX_CLASSES, HostToolSandboxClass } from '../../voltRuntime/common/hostToolSandbox.js';
import { capabilityClass, VOLT_CAPABILITY_CLASSES, VoltCapabilityClass, voltCapabilityClassRank } from './capabilities.js';

/**
 * Volt's contribution points: what a Volt feature or plugin adds, as data in its `package.json`
 * (`contributes.volt*`). Core reads them before any plugin code runs, so an agent's tool list, the
 * sidebar buttons, Settings pages and model providers are known without activating anything.
 *
 * Each point has a JSON schema: the same schema gives IntelliSense in `package.json` (the extension
 * point registry adds it to the manifest schema) and validates manifests at load time
 * (`validateVoltContributes`), where an invalid entry is reported and left out.
 */

export const VOLT_TOOLS_EXTENSION_POINT = 'voltTools';
export const VOLT_SLOT_ITEMS_EXTENSION_POINT = 'voltSlotItems';
export const VOLT_SETTINGS_PAGES_EXTENSION_POINT = 'voltSettingsPages';
export const VOLT_SURFACES_EXTENSION_POINT = 'voltSurfaces';
export const VOLT_DOCK_EXTENSION_POINT = 'voltDock';
export const VOLT_AGENTS_EXTENSION_POINT = 'voltAgents';
export const VOLT_CAPABILITIES_EXTENSION_POINT = 'voltCapabilities';
export const VOLT_MODULE_EXTENSION_POINT = 'voltModule';

/** The categories the Capabilities tab groups features by. */
export const VOLT_MODULE_CATEGORIES = ['agents', 'workspace', 'tools', 'productivity', 'resources', 'providers', 'customize'] as const;
export type VoltModuleCategory = typeof VOLT_MODULE_CATEGORIES[number];

const TOOL_CLASSES: readonly HostToolSandboxClass[] = ['safe', 'browser', 'reads', 'network', 'writes', 'sandboxed', 'reads-other', 'persists', 'delegates', 'spawns', 'escapes'];
const TOOL_CLASS_RANK: Readonly<Record<HostToolSandboxClass, number>> = { safe: 0, browser: 1, reads: 1, network: 2, writes: 2, sandboxed: 2, 'reads-other': 3, persists: 3, delegates: 3, spawns: 4, escapes: 5 };

/** An agent tool the plugin serves on Volt's host MCP server. */
export interface IVoltToolContribution {
	readonly name: string;
	/** What the tool does outside a chat's sandbox (`HostToolSandboxClass`). Never lower than Volt's own class for the name. */
	readonly class: HostToolSandboxClass;
	readonly title?: string;
	readonly description?: string;
	/** The tool's input, as JSON schema. Without one, the code that serves the tool supplies it (first-party tools until they move, M3). */
	readonly inputSchema?: object;
	readonly group?: string;
	/** Why Ask and Plan modes ask before it runs. */
	readonly approvalInReadOnlyModes?: string;
}

/** A sidebar or activity bar button (`VOLT_SLOT_ITEMS`). */
export interface IVoltSlotItemContribution {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** Where it goes when no layout names it. */
	readonly slot?: string;
	readonly command?: string;
}

/** A page in Volt Settings. */
export interface IVoltSettingsPageContribution {
	readonly id: string;
	readonly label: string;
}

/** An entry in the right panel's "+" menu. */
export interface IVoltSurfaceContribution {
	readonly id: string;
	readonly label: string;
	readonly command?: string;
}

/** A section or quick action in the chat's side toolbar. */
export interface IVoltDockContribution {
	readonly id: string;
	readonly label: string;
	readonly command?: string;
}

/**
 * A model provider (spec H.12): data, never an arbitrary `{command, args}`. Core resolves the bare
 * binary name, pins its path and digest, and launches it through the supervisor.
 */
export interface IVoltAgentContribution {
	/** The model picker's provider family (`providerFamily`). */
	readonly id: string;
	readonly label?: string;
	/** A bare executable name, no path. */
	readonly binary?: string;
	/** Launch arguments; only core-defined substitutions (`${model}`, `${projectSlug}`). */
	readonly args?: readonly string[];
	/** The hosts its API calls reach. */
	readonly apiHosts?: readonly string[];
	readonly state?: {
		/** The environment variable that points the CLI at a per-chat config overlay. */
		readonly configOverlay?: string;
		/** Paths in the overlay the agent may write. */
		readonly writable?: readonly string[];
		/** Keys merged back to the real config after a turn. */
		readonly mergeBack?: readonly string[];
	};
	/** How core asks whether the user is signed in. */
	readonly probe?: { readonly command: readonly string[]; readonly parse: string };
	readonly models?: { readonly source: 'acp' | 'api' | 'static'; readonly list?: readonly string[] };
}

/** One capability a plugin asks for, with the class the catalog gives it (G.8). */
export interface IVoltCapabilityDeclaration {
	/** `agents.send`, `net.connect`, `secrets.use:github`, ... */
	readonly id: string;
	readonly class: VoltCapabilityClass;
	/** Hosts, command ids or other targets it is limited to; `*` globs. None: any target. */
	readonly targets?: readonly string[];
	readonly reason?: string;
}

export interface IVoltCapabilitiesContribution {
	/** Asked for at install; the plugin doesn't work without them. */
	readonly required?: readonly IVoltCapabilityDeclaration[];
	/** Asked for when first used. */
	readonly optional?: readonly IVoltCapabilityDeclaration[];
}

/**
 * The Volt feature a built-in extension carries: its place in the Capabilities tab and what it owns
 * that its code registers by id (commands and settings). After M3 `entry` names the feature's own
 * folder, which an import lint fences.
 */
export interface IVoltModuleContribution {
	/** The feature id (`usage`, `provider.claude`). */
	readonly feature: string;
	readonly label: string;
	readonly description: string;
	readonly category: VoltModuleCategory;
	/** Codicon id. */
	readonly icon: string;
	/** Position within its category (core features too). */
	readonly order: number;
	readonly commands?: readonly string[];
	/** Setting keys, or prefixes ending in `.`. */
	readonly settings?: readonly string[];
	readonly entry?: string;
}

export interface IVoltContributes {
	readonly voltTools?: readonly IVoltToolContribution[];
	readonly voltSlotItems?: readonly IVoltSlotItemContribution[];
	readonly voltSettingsPages?: readonly IVoltSettingsPageContribution[];
	readonly voltSurfaces?: readonly IVoltSurfaceContribution[];
	readonly voltDock?: readonly IVoltDockContribution[];
	readonly voltAgents?: readonly IVoltAgentContribution[];
	readonly voltCapabilities?: IVoltCapabilitiesContribution;
	readonly voltModule?: IVoltModuleContribution;
}

/** The part of a `package.json` Volt reads. */
export interface IVoltPluginManifest {
	readonly publisher: string;
	readonly name: string;
	readonly engines?: { readonly volt?: string };
	readonly contributes?: IVoltContributes;
}

export const VOLT_CONTRIBUTION_POINTS = [
	VOLT_TOOLS_EXTENSION_POINT, VOLT_SLOT_ITEMS_EXTENSION_POINT, VOLT_SETTINGS_PAGES_EXTENSION_POINT, VOLT_SURFACES_EXTENSION_POINT,
	VOLT_DOCK_EXTENSION_POINT, VOLT_AGENTS_EXTENSION_POINT, VOLT_CAPABILITIES_EXTENSION_POINT, VOLT_MODULE_EXTENSION_POINT,
] as const satisfies readonly (keyof IVoltContributes)[];

// --- Schemas -----------------------------------------------------------------------------------

const ID = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' } satisfies IJSONSchema;
const TOOL_NAME = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', description: 'The tool name agents call (snake_case).' } satisfies IJSONSchema;
const STRINGS = { type: 'array', items: { type: 'string', minLength: 1 } } satisfies IJSONSchema;

function labelled(description: string, extra: Record<string, IJSONSchema> = {}): IJSONSchema {
	return {
		type: 'array',
		description,
		items: {
			type: 'object',
			required: ['id', 'label'],
			additionalProperties: false,
			properties: { id: ID, label: { type: 'string', minLength: 1 }, ...extra },
		},
	};
}

const CAPABILITY: IJSONSchema = {
	type: 'object',
	required: ['id', 'class'],
	additionalProperties: false,
	properties: {
		id: { type: 'string', pattern: '^[a-z]+(\\.[a-z]+)*(:[A-Za-z0-9._*/-]+)?(@[0-9]+)?$', description: 'A capability id from Volt\'s catalog, e.g. `agents.send` or `secrets.use:github`.' },
		class: { type: 'string', enum: [...VOLT_CAPABILITY_CLASSES] },
		targets: STRINGS,
		reason: { type: 'string' },
	},
};

export const VOLT_CONTRIBUTION_SCHEMAS: Readonly<Record<keyof IVoltContributes, IJSONSchema>> = {
	voltTools: {
		type: 'array',
		description: 'Agent tools served on Volt\'s host MCP server. Listed to agents before the plugin starts.',
		items: {
			type: 'object',
			required: ['name', 'class'],
			additionalProperties: false,
			properties: {
				name: TOOL_NAME,
				class: { type: 'string', enum: [...TOOL_CLASSES], description: 'What the tool does outside a chat\'s sandbox.' },
				title: { type: 'string' },
				description: { type: 'string' },
				inputSchema: { type: 'object', description: 'JSON schema of the tool\'s input.' },
				group: { type: 'string' },
				approvalInReadOnlyModes: { type: 'string' },
			},
		},
	},
	voltSlotItems: labelled('Buttons layouts can place in the agent window\'s slots.', { description: { type: 'string' }, slot: { type: 'string' }, command: { type: 'string' } }),
	voltSettingsPages: labelled('Pages in Volt Settings.'),
	voltSurfaces: labelled('Entries in the right panel\'s "+" menu.', { command: { type: 'string' } }),
	voltDock: labelled('Sections and quick actions in the chat\'s side toolbar.', { command: { type: 'string' } }),
	voltAgents: {
		type: 'array',
		description: 'Model providers, as data.',
		items: {
			type: 'object',
			required: ['id'],
			additionalProperties: false,
			properties: {
				id: ID,
				label: { type: 'string' },
				binary: { type: 'string', pattern: '^[A-Za-z0-9._-]+$', description: 'A bare executable name; core resolves and pins it.' },
				args: STRINGS,
				apiHosts: STRINGS,
				state: {
					type: 'object',
					additionalProperties: false,
					properties: { configOverlay: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$' }, writable: STRINGS, mergeBack: STRINGS },
				},
				probe: {
					type: 'object',
					required: ['command', 'parse'],
					additionalProperties: false,
					properties: { command: { ...STRINGS, minItems: 1 }, parse: { type: 'string', pattern: '^(regex|exit|json):' } },
				},
				models: {
					type: 'object',
					required: ['source'],
					additionalProperties: false,
					properties: { source: { type: 'string', enum: ['acp', 'api', 'static'] }, list: STRINGS },
				},
			},
		},
	},
	voltCapabilities: {
		type: 'object',
		description: 'What the plugin may do, by Volt\'s capability catalog. The API checks every call against it.',
		additionalProperties: false,
		properties: { required: { type: 'array', items: CAPABILITY }, optional: { type: 'array', items: CAPABILITY } },
	},
	voltModule: {
		type: 'object',
		description: 'The Volt feature this extension carries.',
		required: ['feature', 'label', 'description', 'category', 'icon', 'order'],
		additionalProperties: false,
		properties: {
			feature: ID,
			label: { type: 'string', minLength: 1 },
			description: { type: 'string', minLength: 1 },
			category: { type: 'string', enum: [...VOLT_MODULE_CATEGORIES] },
			icon: { type: 'string', pattern: '^[a-z0-9-]+$' },
			order: { type: 'number' },
			commands: STRINGS,
			settings: STRINGS,
			entry: { type: 'string' },
		},
	},
};

// --- Validation --------------------------------------------------------------------------------

/**
 * The subset of JSON schema the contribution schemas use: type, enum, pattern, minLength,
 * required, properties, additionalProperties, items, minItems.
 */
export function validateJsonValue(value: unknown, schema: IJSONSchema, path: string, errors: string[] = []): string[] {
	const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (types.length && !types.some(type => matchesType(value, type))) {
		errors.push(`${path}: expected ${types.join(' or ')}`);
		return errors;
	}
	if (schema.enum && !schema.enum.includes(value)) {
		errors.push(`${path}: must be one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}`);
	}
	if (typeof value === 'string') {
		if (schema.minLength !== undefined && value.length < schema.minLength) {
			errors.push(`${path}: must not be empty`);
		}
		if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
			errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
		}
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
		}
		const items = schema.items;
		if (items && !Array.isArray(items) && typeof items === 'object') {
			value.forEach((item, index) => validateJsonValue(item, items, `${path}[${index}]`, errors));
		}
	} else if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (record[key] === undefined) {
				errors.push(`${path}: missing "${key}"`);
			}
		}
		for (const [key, item] of Object.entries(record)) {
			const property = schema.properties?.[key];
			if (property) {
				validateJsonValue(item, property, `${path}.${key}`, errors);
			} else if (schema.additionalProperties === false) {
				errors.push(`${path}: unknown property "${key}"`);
			} else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
				validateJsonValue(item, schema.additionalProperties, `${path}.${key}`, errors);
			}
		}
	}
	return errors;
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case 'array': return Array.isArray(value);
		case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
		case 'integer': return typeof value === 'number' && Number.isInteger(value);
		case 'null': return value === null;
		default: return typeof value === type;
	}
}

/**
 * Problems with one contribution point's value: its schema, then the rules a schema can't say
 * (unique ids, a tool class no lower than Volt's own for that tool, a capability class no lower
 * than the catalog's). Empty: valid.
 */
export function validateVoltContribution(point: keyof IVoltContributes, value: unknown): string[] {
	const path = `contributes.${point}`;
	const errors = validateJsonValue(value, VOLT_CONTRIBUTION_SCHEMAS[point], path);
	if (errors.length) {
		return errors;
	}
	if (Array.isArray(value)) {
		const key = point === VOLT_TOOLS_EXTENSION_POINT ? 'name' : 'id';
		const seen = new Set<string>();
		for (const entry of value as Record<string, unknown>[]) {
			const id = String(entry[key]);
			if (seen.has(id)) {
				errors.push(`${path}: "${id}" is listed twice`);
			}
			seen.add(id);
		}
	}
	if (point === VOLT_TOOLS_EXTENSION_POINT) {
		for (const tool of value as IVoltToolContribution[]) {
			const known = Object.prototype.hasOwnProperty.call(HOST_TOOL_SANDBOX_CLASSES, tool.name) ? HOST_TOOL_SANDBOX_CLASSES[tool.name] : undefined;
			if (known && TOOL_CLASS_RANK[tool.class] < TOOL_CLASS_RANK[known]) {
				errors.push(`${path}: ${tool.name} is a "${known}" tool and can't be declared "${tool.class}"`);
			}
		}
	}
	if (point === VOLT_CAPABILITIES_EXTENSION_POINT) {
		const declared = value as IVoltCapabilitiesContribution;
		for (const capability of [...declared.required ?? [], ...declared.optional ?? []]) {
			const catalog = capabilityClass(capability.id);
			if (!catalog) {
				errors.push(`${path}: "${capability.id}" is not a Volt capability`);
			} else if (voltCapabilityClassRank(capability.class) < voltCapabilityClassRank(catalog)) {
				errors.push(`${path}: "${capability.id}" is ${catalog} and can't be declared ${capability.class}`);
			}
		}
	}
	return errors;
}

/** Every Volt contribution point in a manifest's `contributes`. */
export function validateVoltContributes(contributes: unknown): string[] {
	if (!contributes || typeof contributes !== 'object') {
		return [];
	}
	const record = contributes as Record<string, unknown>;
	return VOLT_CONTRIBUTION_POINTS.flatMap(point => record[point] === undefined ? [] : validateVoltContribution(point, record[point]));
}

/** The Volt points of a manifest's `contributes`, and nothing else (what the catalog generator reads). */
export function pickVoltContributes(contributes: unknown): IVoltContributes {
	const record = contributes && typeof contributes === 'object' ? contributes as Record<string, unknown> : {};
	const picked: Record<string, unknown> = {};
	for (const point of VOLT_CONTRIBUTION_POINTS) {
		if (record[point] !== undefined) {
			picked[point] = record[point];
		}
	}
	return picked as IVoltContributes;
}
