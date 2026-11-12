/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Command visibility lint (spec I.14, B-09). Every Volt command says who may run it: `internal`
// (Volt's own code only), `exported:<capability>` or `public` (extensions too). MainThreadCommands
// refuses an extension's call to an internal command, and a Volt command without a visibility is
// internal, so a forgotten one fails closed; this lint makes the choice explicit where it is made.
//
// A registration needs `visibility` when its command id is a Volt id (`volt.`, `voltAgent.`,
// `_volt.`, ... see isVoltCommandId) or it sits in a Volt file (a path segment or file name that
// starts with `volt`). It reads:
//   registerAction2(class extends Action2 { constructor() { super({ id, visibility, ... }) } })
//   CommandsRegistry.registerCommand({ id, handler, visibility })
//   CommandsRegistry.registerCommand(id, handler, visibility)
//   KeybindingsRegistry.registerCommandAndKeybindingRule({ id, handler, visibility, ... })
// Aliases (registerCommandAlias) take their target's visibility and need none.
//
// Usage: node build/volt/ci/commandVisibility.mjs [--staged | file ...] [--list]
//   no arguments: every file under src/vs; --staged: the staged src/vs files (pre-commit);
//   --list: print every Volt registration with its visibility instead of failing.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(path.join(root, 'package.json'));
/** @type {typeof import('typescript')} */
const ts = require('typescript');

const VISIBILITY = /^(internal|public|exported:[A-Za-z0-9_.:*-]+)$/;

/** Volt's command id families: `volt.x`, `voltAgent.x`, `_volt.x`, `_voltScratch.x`. */
export function isVoltCommandId(id) {
	return /^_?volt[A-Za-z0-9]*\./.test(id);
}

/** A file Volt added: a path segment (folder or file name) that starts with `volt`. */
export function isVoltFile(file) {
	return file.split(/[\\/]/).some(segment => /^volt/i.test(segment));
}

/**
 * Reads sources and resolves the string constants command ids are written with, across imports.
 * `read(file)` returns the text or undefined.
 */
export class SourceIndex {
	constructor(read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } }) {
		this.read = read;
		/** @type {Map<string, import('typescript').SourceFile | null>} */
		this.files = new Map();
	}

	/** @returns {import('typescript').SourceFile | undefined} */
	source(file) {
		if (!this.files.has(file)) {
			const text = this.read(file);
			this.files.set(file, text === undefined ? null : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
		}
		return this.files.get(file) ?? undefined;
	}

	/** The declaration named `name` at the top level of `file`, following imports and re-exports. */
	declaration(file, name, depth = 0) {
		const source = this.source(file);
		if (!source || depth > 8) {
			return undefined;
		}
		for (const statement of source.statements) {
			if (ts.isVariableStatement(statement)) {
				for (const decl of statement.declarationList.declarations) {
					if (ts.isIdentifier(decl.name) && decl.name.text === name) {
						return { file, node: decl };
					}
				}
			} else if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name?.text === name) {
				return { file, node: statement };
			} else if (ts.isImportDeclaration(statement) && statement.importClause && ts.isStringLiteral(statement.moduleSpecifier)) {
				const bindings = statement.importClause.namedBindings;
				if (bindings && ts.isNamedImports(bindings)) {
					for (const element of bindings.elements) {
						if (element.name.text === name) {
							const target = this.resolveModule(file, statement.moduleSpecifier.text);
							return target ? this.declaration(target, (element.propertyName ?? element.name).text, depth + 1) : undefined;
						}
					}
				}
			} else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
				const target = this.resolveModule(file, statement.moduleSpecifier.text);
				if (!target) {
					continue;
				}
				if (!statement.exportClause) {
					const found = this.declaration(target, name, depth + 1);
					if (found) {
						return found;
					}
				} else if (ts.isNamedExports(statement.exportClause)) {
					for (const element of statement.exportClause.elements) {
						if (element.name.text === name) {
							return this.declaration(target, (element.propertyName ?? element.name).text, depth + 1);
						}
					}
				}
			}
		}
		return undefined;
	}

	resolveModule(from, specifier) {
		if (!specifier.startsWith('.')) {
			return undefined;
		}
		const base = path.resolve(path.dirname(from), specifier).replace(/\.js$/, '');
		for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
			if (this.source(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	/** The string an expression evaluates to, when it is built from literals and constants. */
	evaluate(file, expr, depth = 0) {
		if (!expr || depth > 12) {
			return undefined;
		}
		expr = unwrap(expr);
		if (ts.isStringLiteralLike(expr)) {
			return expr.text;
		}
		if (ts.isTemplateExpression(expr)) {
			let out = expr.head.text;
			for (const span of expr.templateSpans) {
				const part = this.evaluate(file, span.expression, depth + 1);
				if (part === undefined) {
					return undefined;
				}
				out += part + span.literal.text;
			}
			return out;
		}
		if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			const left = this.evaluate(file, expr.left, depth + 1);
			const right = left === undefined ? undefined : this.evaluate(file, expr.right, depth + 1);
			return right === undefined ? undefined : left + right;
		}
		if (ts.isIdentifier(expr)) {
			const local = findLocalConst(expr);
			if (local) {
				return this.evaluate(file, local, depth + 1);
			}
			const found = this.declaration(file, expr.text);
			if (found && ts.isVariableDeclaration(found.node)) {
				return this.evaluate(found.file, found.node.initializer, depth + 1);
			}
			return undefined;
		}
		if (ts.isPropertyAccessExpression(expr)) {
			const member = expr.name.text;
			const owner = unwrap(expr.expression);
			let found;
			if (ts.isIdentifier(owner)) {
				found = this.declaration(file, owner.text);
				if (!found) {
					const cls = enclosingClassNamed(expr, owner.text);
					found = cls ? { file, node: cls } : undefined;
				}
			} else if (owner.kind === ts.SyntaxKind.ThisKeyword) {
				const cls = enclosingClass(expr);
				found = cls ? { file, node: cls } : undefined;
			}
			if (!found) {
				return undefined;
			}
			const node = found.node;
			if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
				for (const m of node.members) {
					if (ts.isPropertyDeclaration(m) && m.name && ts.isIdentifier(m.name) && m.name.text === member && m.initializer) {
						return this.evaluate(found.file, m.initializer, depth + 1);
					}
				}
			} else if (ts.isEnumDeclaration(node)) {
				for (const m of node.members) {
					if (m.name.getText() === member && m.initializer) {
						return this.evaluate(found.file, m.initializer, depth + 1);
					}
				}
			} else if (ts.isVariableDeclaration(node) && node.initializer) {
				const init = unwrap(node.initializer);
				if (ts.isObjectLiteralExpression(init)) {
					const prop = init.properties.find(p => ts.isPropertyAssignment(p) && propertyName(p) === member);
					return prop ? this.evaluate(found.file, prop.initializer, depth + 1) : undefined;
				}
			}
		}
		return undefined;
	}

	/** The object literal an expression stands for (`{...}` or a constant holding one). */
	objectLiteral(file, expr, depth = 0) {
		if (!expr || depth > 6) {
			return undefined;
		}
		expr = unwrap(expr);
		if (ts.isObjectLiteralExpression(expr)) {
			return { file, node: expr };
		}
		if (ts.isIdentifier(expr)) {
			const local = findLocalConst(expr);
			if (local) {
				return this.objectLiteral(file, local, depth + 1);
			}
			const found = this.declaration(file, expr.text);
			if (found && ts.isVariableDeclaration(found.node)) {
				return this.objectLiteral(found.file, found.node.initializer, depth + 1);
			}
		}
		return undefined;
	}

	/** The class a `registerAction2(...)` argument names. */
	classOf(file, expr) {
		expr = unwrap(expr);
		if (ts.isClassExpression(expr) || ts.isClassDeclaration(expr)) {
			return { file, node: expr };
		}
		if (ts.isIdentifier(expr)) {
			const local = findLocalClass(expr);
			if (local) {
				return { file, node: local };
			}
			const found = this.declaration(file, expr.text);
			if (found && (ts.isClassDeclaration(found.node))) {
				return found;
			}
		}
		return undefined;
	}

	/**
	 * The options object an Action2 class passes to `super(...)`, following base classes that
	 * declare no constructor of their own or pass something else up (`super(() => tracker)`).
	 */
	actionOptions(file, cls, depth = 0) {
		if (depth > 6) {
			return undefined;
		}
		const ctor = cls.members.find(ts.isConstructorDeclaration);
		if (ctor?.body) {
			let call;
			const visit = node => {
				if (!call && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
					call = node;
				}
				if (!call) {
					ts.forEachChild(node, visit);
				}
			};
			visit(ctor.body);
			const options = call?.arguments.length ? this.objectLiteral(file, call.arguments[0]) : undefined;
			if (options) {
				return options;
			}
		}
		const heritage = cls.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
		if (heritage && ts.isIdentifier(heritage) && heritage.text === 'Action2') {
			return undefined;
		}
		const base = heritage && this.classOf(file, heritage);
		return base ? this.actionOptions(base.file, base.node, depth + 1) : undefined;
	}

	/** `name`'s value in an object literal, looking into spread constants. */
	property(file, literal, name, depth = 0) {
		if (depth > 4) {
			return undefined;
		}
		for (const prop of [...literal.properties].reverse()) {
			if ((ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) && propertyName(prop) === name) {
				return { file, node: ts.isPropertyAssignment(prop) ? prop.initializer : prop.name };
			}
			if (ts.isSpreadAssignment(prop)) {
				const spread = this.objectLiteral(file, prop.expression);
				const found = spread && this.property(spread.file, spread.node, name, depth + 1);
				if (found) {
					return found;
				}
			}
		}
		return undefined;
	}
}

function unwrap(expr) {
	while (expr && (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isTypeAssertionExpression(expr) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(expr)) || ts.isNonNullExpression(expr))) {
		expr = expr.expression;
	}
	return expr;
}

function propertyName(prop) {
	const name = prop.name;
	return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

/** A `const name = ...` in a block around the use (not at the top level, which `declaration` reads). */
function findLocalConst(identifier) {
	for (let node = identifier.parent; node; node = node.parent) {
		const statements = ts.isBlock(node) || ts.isSourceFile(node) ? node.statements : undefined;
		if (!statements) {
			continue;
		}
		for (const statement of statements) {
			if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
				for (const decl of statement.declarationList.declarations) {
					if (ts.isIdentifier(decl.name) && decl.name.text === identifier.text && decl.initializer && decl !== identifier.parent) {
						return decl.initializer;
					}
				}
			}
		}
	}
	return undefined;
}

function findLocalClass(identifier) {
	for (let node = identifier.parent; node; node = node.parent) {
		const statements = ts.isBlock(node) || ts.isSourceFile(node) ? node.statements : undefined;
		const found = statements?.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === identifier.text);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function enclosingClass(node) {
	for (let current = node.parent; current; current = current.parent) {
		if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
			return current;
		}
	}
	return undefined;
}

function enclosingClassNamed(node, name) {
	for (let current = node.parent; current; current = current.parent) {
		if ((ts.isClassDeclaration(current) || ts.isClassExpression(current)) && current.name?.text === name) {
			return current;
		}
	}
	return undefined;
}

/**
 * @typedef {{ file: string, line: number, id: string | undefined, idText: string, visibility: string | undefined, problem?: string, call?: import('typescript').Node, idNode?: import('typescript').Node, idFile?: string }} Registration
 */

/**
 * Every command registration in `file` that needs a visibility (see the header), with the one it has.
 * @returns {Registration[]}
 */
export function voltRegistrations(index, file) {
	const source = index.source(file);
	if (!source) {
		return [];
	}
	const voltFile = isVoltFile(path.relative(root, file));
	/** @type {Registration[]} */
	const out = [];
	const add = (node, idNode, idFile, visibilityNode, visibilityFile) => {
		const id = idNode ? index.evaluate(idFile, idNode) : undefined;
		if (!voltFile && !(id !== undefined && isVoltCommandId(id))) {
			return;
		}
		const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
		const visibility = visibilityNode ? index.evaluate(visibilityFile, visibilityNode) : undefined;
		/** @type {Registration} */
		const entry = { file, line, id, idText: idNode ? idNode.getText() : '?', visibility, call: node, idNode, idFile };
		if (visibilityNode === undefined) {
			entry.problem = 'has no visibility';
		} else if (visibility === undefined || !VISIBILITY.test(visibility)) {
			entry.problem = `has a visibility that is not internal, public or exported:<capability> (${visibilityNode.getText()})`;
		}
		out.push(entry);
	};
	const visit = node => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
			const owner = ts.isPropertyAccessExpression(callee) ? callee.expression.getText(source) : undefined;
			const [first, second, third] = node.arguments;
			if (name === 'registerAction2' && first) {
				const cls = index.classOf(file, first);
				const options = cls && index.actionOptions(cls.file, cls.node);
				if (options) {
					const id = index.property(options.file, options.node, 'id');
					const visibility = index.property(options.file, options.node, 'visibility');
					add(node, id?.node, id?.file, visibility?.node, visibility?.file);
				} else if (voltFile) {
					out.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, id: undefined, idText: first.getText(source).slice(0, 60), visibility: undefined, problem: 'registers an action whose options this lint cannot read (pass an object literal to super)' });
				}
			} else if ((name === 'registerCommand' && owner === 'CommandsRegistry') || (name === 'registerCommandAndKeybindingRule' && owner === 'KeybindingsRegistry')) {
				const literal = first && index.objectLiteral(file, first);
				if (literal) {
					const id = index.property(literal.file, literal.node, 'id');
					const visibility = index.property(literal.file, literal.node, 'visibility');
					add(node, id?.node, id?.file, visibility?.node, visibility?.file);
				} else if (first) {
					add(node, first, file, name === 'registerCommand' ? third : undefined, file);
					void second;
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return out;
}

const REGISTERS = /registerAction2|registerCommand/;

function listFiles(dir, into) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'test' && entry.name !== 'node_modules') {
				listFiles(full, into);
			}
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
			into.push(full);
		}
	}
	return into;
}

function stagedFiles() {
	const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: root, encoding: 'utf8' });
	return out.split(/\r?\n/).filter(file => /^src\/vs\/.*\.ts$/.test(file) && !file.endsWith('.d.ts') && !file.split('/').includes('test')).map(file => path.join(root, file));
}

function main(argv) {
	const list = argv.includes('--list');
	const named = argv.filter(arg => !arg.startsWith('--'));
	const files = argv.includes('--staged') ? stagedFiles() : named.length ? named.map(file => path.resolve(file)) : listFiles(path.join(root, 'src', 'vs'), []);
	const index = new SourceIndex();
	const found = [];
	for (const file of files) {
		const text = index.read(file);
		if (text !== undefined && REGISTERS.test(text)) {
			found.push(...voltRegistrations(index, file));
		}
	}
	if (list) {
		for (const entry of found) {
			console.log(`${path.relative(root, entry.file)}:${entry.line}\t${entry.id ?? `? ${entry.idText}`}\t${entry.visibility ?? '-'}`);
		}
		return 0;
	}
	const problems = found.filter(entry => entry.problem);
	for (const entry of problems) {
		console.error(`${path.relative(root, entry.file)}:${entry.line}: command ${entry.id ?? entry.idText} ${entry.problem}`);
	}
	if (problems.length) {
		console.error(`\n${problems.length} Volt command registration${problems.length === 1 ? '' : 's'} without a valid visibility. Add \`visibility: 'internal'\` (Volt's code only), 'public' (extensions may run it) or 'exported:<capability>'. See src/vs/platform/commands/common/commands.ts (CommandVisibility).`);
		return 1;
	}
	return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
	process.exit(main(process.argv.slice(2)));
}
