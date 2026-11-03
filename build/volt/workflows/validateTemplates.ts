/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Validates the workflow templates repository (workflow-templates/) with Volt's own parser and
// checks: index.json, every template it lists (no errors allowed), no unlisted templates, ids that
// match file names, the built-in templates' copies and the schema files. Prints file:line:col
// messages and exits 1 on any error. Runs from source with Bun (no build, no node_modules).
//
// Usage: bun build/volt/workflows/validateTemplates.ts [--write] [--verbose] [files...]
//   files      check only these templates (or an index.json and what it lists), e.g. a new template
//   --write    first regenerate schema/*.json and the built-in templates' copies from the source
//   --verbose  also print info-level notes

import * as fs from 'fs';
import * as path from 'path';

interface IIssue {
	readonly severity: 'error' | 'warning' | 'info';
	readonly code: string;
	readonly message: string;
	readonly line?: number;
	readonly column?: number;
}

interface IEntry {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly path: string;
	readonly nodeTypes?: readonly string[];
	readonly permissions?: readonly string[];
}

interface IDefinition {
	readonly id: string;
	readonly name: string;
	readonly nodes: readonly { readonly type: string }[];
}

interface ISchemaModule {
	parseWorkflowYaml(text: string): { readonly definition?: IDefinition; readonly issues: readonly IIssue[] };
	readonly WORKFLOW_JSON_SCHEMA: unknown;
}

interface ITemplatesModule {
	validateTemplateYaml(text: string): readonly IIssue[];
	parseTemplateIndex(raw: unknown): { readonly index?: { readonly templates: readonly IEntry[] }; readonly errors: readonly string[] };
	describeTemplate(definition: IDefinition): { readonly nodeTypes: readonly string[]; readonly permissions: readonly string[] };
	readonly BUILT_IN_WORKFLOW_TEMPLATES: readonly (IEntry & { readonly yaml: string })[];
	readonly WORKFLOW_TEMPLATE_INDEX_JSON_SCHEMA: unknown;
}

const root = path.resolve(__dirname, '..', '..', '..');
const sources = path.join(root, 'src', 'vs', 'workbench', 'services', 'voltRuntime', 'common', 'workflows');
const repository = path.join(root, 'workflow-templates');
const schemaFiles = {
	workflow: path.join(repository, 'schema', 'workflow.schema.json'),
	index: path.join(repository, 'schema', 'index.schema.json'),
};

let errorCount = 0;
let warningCount = 0;
let verbose = false;

/** Paths under the working folder relative (clickable in terminals and CI logs), others absolute. */
function relative(file: string): string {
	const rel = path.relative(process.cwd(), file);
	return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

function report(severity: IIssue['severity'], file: string, message: string, line?: number, column?: number): void {
	if (severity === 'info' && !verbose) {
		return;
	}
	const where = `${relative(file)}${line ? `:${line}${column ? `:${column}` : ''}` : ''}`;
	const text = `${where}: ${severity}: ${message}`;
	if (severity === 'error') {
		errorCount++;
		console.error(text);
	} else {
		if (severity === 'warning') {
			warningCount++;
		}
		console.log(text);
	}
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every(item => b.includes(item));
}

/** The 1-based line of the first line holding `needle`, for messages about JSON files. */
function lineOf(text: string, needle: string): number | undefined {
	const index = text.indexOf(needle);
	return index < 0 ? undefined : text.slice(0, index).split('\n').length;
}

function jsonText(value: unknown): string {
	return `${JSON.stringify(value, null, '\t')}\n`;
}

function listYaml(folder: string): string[] {
	if (!fs.existsSync(folder)) {
		return [];
	}
	return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
		const full = path.join(folder, entry.name);
		return entry.isDirectory() ? listYaml(full) : /\.ya?ml$/i.test(entry.name) ? [full] : [];
	});
}

/** One template file: Volt's template checks (errors fail), then its id against the file name. */
function checkTemplate(templates: ITemplatesModule, schema: ISchemaModule, file: string, entry?: IEntry): void {
	if (!fs.existsSync(file)) {
		report('error', file, 'file not found');
		return;
	}
	const text = fs.readFileSync(file, 'utf8');
	const issues = [...templates.validateTemplateYaml(text)].sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
	for (const issue of issues) {
		report(issue.severity, file, `${issue.message} [${issue.code}]`, issue.line, issue.column);
	}
	const definition = schema.parseWorkflowYaml(text).definition;
	if (!definition) {
		return;
	}
	const fileId = path.basename(file).replace(/\.ya?ml$/i, '');
	if (definition.id !== fileId) {
		report('error', file, `the workflow id "${definition.id}" must match the file name (${fileId}.yaml)`, lineOf(text, 'id:'));
	}
	if (!entry) {
		return;
	}
	if (definition.name !== entry.name) {
		report('error', file, `the workflow name "${definition.name}" differs from its index.json name "${entry.name}"`, lineOf(text, 'name:'));
	}
	const facts = templates.describeTemplate(definition);
	if (!entry.nodeTypes) {
		report('error', file, `its index.json entry needs "nodeTypes": ${JSON.stringify(facts.nodeTypes)}`);
	} else if (!sameSet(entry.nodeTypes, facts.nodeTypes)) {
		report('error', file, `index.json lists node types ${JSON.stringify(entry.nodeTypes)}, the template uses ${JSON.stringify(facts.nodeTypes)}`);
	}
	if (!entry.permissions) {
		report('error', file, `its index.json entry needs "permissions": ${JSON.stringify(facts.permissions)}`);
	} else if (!sameSet(entry.permissions, facts.permissions)) {
		report('error', file, `index.json lists permissions ${JSON.stringify(entry.permissions)}, the template needs ${JSON.stringify(facts.permissions)}`);
	}
}

/** An index.json and everything it lists; returns the files it references. */
function checkIndex(templates: ITemplatesModule, schema: ISchemaModule, indexFile: string): Set<string> {
	const referenced = new Set<string>();
	if (!fs.existsSync(indexFile)) {
		report('error', indexFile, 'file not found');
		return referenced;
	}
	const text = fs.readFileSync(indexFile, 'utf8');
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		report('error', indexFile, `not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		return referenced;
	}
	const parsed = templates.parseTemplateIndex(raw);
	for (const message of parsed.errors) {
		const id = /^templates\[\d+\] \(([^)]+)\)/.exec(message)?.[1];
		report('error', indexFile, message, id ? lineOf(text, `"id": "${id}"`) : undefined);
	}
	const folder = path.dirname(indexFile);
	for (const entry of parsed.index?.templates ?? []) {
		const file = path.join(folder, entry.path);
		referenced.add(file);
		if (entry.path !== `templates/${entry.id}.yaml`) {
			report('error', indexFile, `"${entry.id}" must live at templates/${entry.id}.yaml (not ${entry.path})`, lineOf(text, `"id": "${entry.id}"`));
		}
		checkTemplate(templates, schema, file, entry);
	}
	return referenced;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const write = args.includes('--write');
	verbose = args.includes('--verbose');
	const files = args.filter(arg => !arg.startsWith('--')).map(arg => path.resolve(arg));

	// computed paths keep the build's type check from following these imports into src/
	const schema = await import(path.join(sources, 'workflowSchema.ts')) as ISchemaModule;
	const templates = await import(path.join(sources, 'workflowTemplates.ts')) as ITemplatesModule;

	if (files.length) {
		for (const file of files) {
			if (path.basename(file) === 'index.json') {
				checkIndex(templates, schema, file);
			} else {
				checkTemplate(templates, schema, file);
			}
		}
	} else {
		if (write) {
			fs.mkdirSync(path.dirname(schemaFiles.workflow), { recursive: true });
			fs.writeFileSync(schemaFiles.workflow, jsonText(schema.WORKFLOW_JSON_SCHEMA));
			fs.writeFileSync(schemaFiles.index, jsonText(templates.WORKFLOW_TEMPLATE_INDEX_JSON_SCHEMA));
			fs.mkdirSync(path.join(repository, 'templates'), { recursive: true });
			for (const template of templates.BUILT_IN_WORKFLOW_TEMPLATES) {
				fs.writeFileSync(path.join(repository, template.path), template.yaml);
			}
			console.log(`Wrote the schema files and ${templates.BUILT_IN_WORKFLOW_TEMPLATES.length} built-in templates.`);
		}

		const indexFile = path.join(repository, 'index.json');
		const referenced = checkIndex(templates, schema, indexFile);

		for (const file of listYaml(path.join(repository, 'templates'))) {
			if (!/\.yaml$/.test(file)) {
				report('error', file, 'templates use the .yaml extension');
			} else if (!referenced.has(file)) {
				report('error', file, 'not listed in index.json: add an entry for it (or delete the file)');
			}
		}

		const indexText = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
		for (const template of templates.BUILT_IN_WORKFLOW_TEMPLATES) {
			const file = path.join(repository, template.path);
			if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== template.yaml) {
				report('error', file, `differs from the built-in template "${template.id}" in workflowTemplates.ts: run with --write`);
			}
			if (!indexText.includes(`"id": "${template.id}"`)) {
				report('error', indexFile, `the built-in template "${template.id}" is not listed`);
			}
		}

		for (const [file, value] of [[schemaFiles.workflow, schema.WORKFLOW_JSON_SCHEMA], [schemaFiles.index, templates.WORKFLOW_TEMPLATE_INDEX_JSON_SCHEMA]] as const) {
			if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== jsonText(value)) {
				report('error', file, 'out of date with workflowSchema.ts / workflowTemplates.ts: run with --write');
			}
		}
	}

	const summary = `Workflow templates: ${errorCount} error${errorCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'}`;
	if (errorCount) {
		console.error(summary);
		process.exit(1);
	}
	console.log(summary);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
