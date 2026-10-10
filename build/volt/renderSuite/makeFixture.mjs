/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Writes the render-suite fixture repo (the task scenarios T01-T09 run in it) into a scratch
// directory and makes it a git repo with one commit. Usage: node makeFixture.mjs <dest>

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FILES = {
	'README.md': `# Render suite fixture

A tiny repo the render-suite task prompts (T01-T09) run against. Copy it to a scratch
directory and \`git init\` it before each run; never run the tasks in this checkout.
`,
	'package.json': `{
	"name": "render-suite-fixture",
	"version": "1.0.0",
	"type": "module",
	"scripts": {
		"test": "node --test src/",
		"lint": "node -e \\"process.exit(0)\\""
	}
}
`,
	'src/math.js': `export function add(a, b) {
	return a + b;
}

export function divide(a, b) {
	return a / b;
}

export function average(values) {
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}
`,
	'src/math.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, divide, average } from './math.js';

test('add', () => assert.equal(add(2, 3), 5));
test('divide', () => assert.equal(divide(6, 3), 2));
test('average', () => assert.equal(average([1, 2, 3]), 2));
test('average of empty list is 0', () => assert.equal(average([]), 0));
`,
	'src/routes/users.ts': `import { loadUser } from '../users.js';

export async function getUser(req: { params: { id: string } }, res: { json(v: unknown): void }) {
	const user = await loadUser(req.params.id);
	res.json(user);
}
`,
	'src/users.ts': `export interface User {
	id: string;
	name: string;
}

export async function loadUser(id: string): Promise<User> {
	const res = await fetch(\`/api/users/\${id}\`);
	const body = await res.json();
	if (!res.ok) {
		throw new Error(body.message);
	}
	return body as User;
}
`,
};

const dest = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
	console.error('usage: node makeFixture.mjs <dest>');
	process.exit(1);
}
for (const [rel, text] of Object.entries(FILES)) {
	fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
	fs.writeFileSync(path.join(dest, rel), text);
}
const git = (...args) => execFileSync('git', args, { cwd: dest, stdio: 'ignore' });
git('init', '-q');
git('add', '-A');
git('-c', 'user.name=Render Suite', '-c', 'user.email=render-suite@example.invalid', 'commit', '-q', '-m', 'fixture');
console.log(dest);
