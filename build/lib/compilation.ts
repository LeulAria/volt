/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import es from 'event-stream';
import fs from 'fs';
import gulp from 'gulp';
import path from 'path';
import * as monacodts from './monaco-api';
import * as nls from './nls';
import { createReporter } from './reporter';
import * as util from './util';
import fancyLog from 'fancy-log';
import ansiColors from 'ansi-colors';
import os from 'os';
import File from 'vinyl';
import * as task from './task';
import { Mangler } from './mangle/index';
import { RawSourceMap } from 'source-map';
import ts = require('typescript');
import { DevTranspileEngine, isFastTranspileEngine, resolveDevTranspileEngine } from './tsb/devEngine';
const watch = require('./watch');


// --- gulp-tsb: compile and transpile --------------------------------

const reporter = createReporter();

function getTypeScriptCompilerOptions(src: string): ts.CompilerOptions {
	const rootDir = path.join(__dirname, `../../${src}`);
	const options: ts.CompilerOptions = {};
	options.verbose = false;
	options.sourceMap = true;
	if (process.env['VSCODE_NO_SOURCEMAP']) { // To be used by developers in a hurry
		options.sourceMap = false;
	}
	options.rootDir = rootDir;
	options.baseUrl = rootDir;
	options.sourceRoot = util.toFileUri(rootDir);
	options.newLine = /\r\n/.test(fs.readFileSync(__filename, 'utf8')) ? 0 : 1;
	return options;
}

interface ICompileTaskOptions {
	readonly build: boolean;
	readonly emitError: boolean;
	readonly transpileOnly: boolean | { esbuild?: boolean; engine?: DevTranspileEngine };
	readonly preserveEnglish: boolean;
}

export function createCompile(src: string, { build, emitError, transpileOnly, preserveEnglish }: ICompileTaskOptions) {
	const tsb = require('./tsb') as typeof import('./tsb');
	const sourcemaps = require('gulp-sourcemaps') as typeof import('gulp-sourcemaps');


	const projectPath = path.join(__dirname, '../../', src, 'tsconfig.json');
	const overrideOptions = { ...getTypeScriptCompilerOptions(src), inlineSources: Boolean(build) };
	if (!build) {
		overrideOptions.inlineSourceMap = true;
	}

	const engine = typeof transpileOnly === 'object'
		? (transpileOnly.engine ?? (transpileOnly.esbuild ? 'esbuild' : 'oxc'))
		: undefined;
	const compilation = tsb.create(projectPath, overrideOptions, {
		verbose: false,
		transpileOnly: Boolean(transpileOnly),
		transpileWithEsbuild: engine === 'esbuild',
		transpileEngine: engine
	}, err => reporter(err));

	function pipeline(token?: util.ICancellationToken) {
		const bom = require('gulp-bom') as typeof import('gulp-bom');

		const tsFilter = util.filter(data => /\.ts$/.test(data.path));
		const isUtf8Test = (f: File) => /(\/|\\)test(\/|\\).*utf8/.test(f.path);
		const isRuntimeJs = (f: File) => f.path.endsWith('.js') && !f.path.includes('fixtures');
		const noDeclarationsFilter = util.filter(data => !(/\.d\.ts$/.test(data.path)));

		const input = es.through();
		const output = input
			.pipe(util.$if(isUtf8Test, bom())) // this is required to preserve BOM in test files that loose it otherwise
			.pipe(util.$if(!build && isRuntimeJs, util.appendOwnPathSourceURL()))
			.pipe(tsFilter)
			.pipe(util.loadSourcemaps())
			.pipe(compilation(token))
			.pipe(noDeclarationsFilter)
			.pipe(util.$if(build, nls.nls({ preserveEnglish })))
			.pipe(noDeclarationsFilter.restore)
			.pipe(util.$if(!transpileOnly, sourcemaps.write('.', {
				addComment: false,
				includeContent: !!build,
				sourceRoot: overrideOptions.sourceRoot
			})))
			.pipe(tsFilter.restore)
			.pipe(reporter.end(!!emitError));

		return es.duplex(input, output);
	}
	pipeline.tsProjectSrc = () => {
		return compilation.src({ base: src });
	};
	pipeline.projectPath = projectPath;
	return pipeline;
}

export function transpileTask(src: string, out: string, esbuild?: boolean): task.StreamTask {

	const task = () => {
		const engine = esbuild ? 'esbuild' : resolveDevTranspileEngine();
		const transpile = createCompile(src, { build: false, emitError: true, transpileOnly: { engine: isFastTranspileEngine(engine) ? engine : 'oxc' }, preserveEnglish: false });
		const srcPipe = gulp.src(`${src}/**`, { base: `${src}` });

		return srcPipe
			.pipe(transpile())
			.pipe(gulp.dest(out));
	};

	task.taskName = `transpile-${path.basename(src)}`;
	return task;
}

export function compileTask(src: string, out: string, build: boolean, options: { disableMangle?: boolean; preserveEnglish?: boolean } = {}): task.StreamTask | task.PromiseTask {

	// VOLT_BUILD_IGNORE_TYPE_ERRORS=1: report type errors but still package. Mangling needs a clean type check, so it is off too.
	const ignoreTypeErrors = !!process.env.VOLT_BUILD_IGNORE_TYPE_ERRORS;
	const mangle = build && !options.disableMangle && !ignoreTypeErrors;
	// Without mangling, product builds type-check and emit with tsgo (the native TypeScript
	// compiler, ~6 s for src); VOLT_BUILD_ENGINE=tsc keeps the single-threaded TypeScript
	// emitter. Mangling rewrites TypeScript through the language service, so it stays on tsc.
	if (build && !mangle && process.env.VOLT_BUILD_ENGINE !== 'tsc') {
		const fast: task.PromiseTask = fastProductCompile(src, out, { ignoreTypeErrors, preserveEnglish: !!options.preserveEnglish });
		fast.taskName = `compile-${path.basename(src)}`;
		return fast;
	}

	const task = () => {

		if (os.totalmem() < 4_000_000_000) {
			throw new Error('compilation requires 4GB of RAM');
		}

		const compile = createCompile(src, { build, emitError: !ignoreTypeErrors, transpileOnly: false, preserveEnglish: !!options.preserveEnglish });
		const srcPipe = gulp.src(`${src}/**`, { base: `${src}` });
		const generator = new MonacoGenerator(false);
		if (src === 'src') {
			generator.execute();
		}

		// mangle: TypeScript to TypeScript
		let mangleStream = es.through();
		if (mangle) {
			let ts2tsMangler = new Mangler(compile.projectPath, (...data) => fancyLog(ansiColors.blue('[mangler]'), ...data), { mangleExports: true, manglePrivateFields: true });
			const newContentsByFileName = ts2tsMangler.computeNewFileContents(new Set(['saveState']));
			mangleStream = es.through(async function write(data: File & { sourceMap?: RawSourceMap }) {
				type TypeScriptExt = typeof ts & { normalizePath(path: string): string };
				const tsNormalPath = (<TypeScriptExt>ts).normalizePath(data.path);
				const newContents = (await newContentsByFileName).get(tsNormalPath);
				if (newContents !== undefined) {
					data.contents = Buffer.from(newContents.out);
					data.sourceMap = newContents.sourceMap && JSON.parse(newContents.sourceMap);
				}
				this.push(data);
			}, async function end() {
				// free resources
				(await newContentsByFileName).clear();

				this.push(null);
				(<any>ts2tsMangler) = undefined;
			});
		}

		return srcPipe
			.pipe(mangleStream)
			.pipe(generator.stream)
			.pipe(compile())
			.pipe(gulp.dest(out));
	};

	task.taskName = `compile-${path.basename(src)}`;
	return task;
}

/**
 * Product compile with tsgo: one native compiler run type-checks src and emits JavaScript and source
 * maps into a scratch folder (same output as the TypeScript emitter, const enums inlined), then the
 * usual steps run on it: NLS, source maps, resources, the import cycle check. Type errors and cycles
 * fail the task unless VOLT_BUILD_IGNORE_TYPE_ERRORS is set.
 */
function fastProductCompile(src: string, out: string, options: { ignoreTypeErrors: boolean; preserveEnglish: boolean }): () => Promise<void> {
	return async () => {
		const started = Date.now();
		const root = path.join(__dirname, '../..');
		const srcRoot = path.join(root, src);
		const emitDir = path.join(root, '.build', `tsgo-${path.basename(out)}`);
		const generator = new MonacoGenerator(false);
		if (src === 'src') {
			generator.execute();
		}
		await fs.promises.rm(emitDir, { recursive: true, force: true });
		const typeErrors = await runTsgo(path.join(srcRoot, 'tsconfig.json'), [
			'--outDir', emitDir, '--rootDir', srcRoot, '--sourceMap', '--inlineSources',
			'--sourceRoot', util.toFileUri(srcRoot), '--newLine', 'lf', '--noEmitOnError', 'false',
		]);
		fancyLog(`tsgo checked and emitted ${src} after ${ansiColors.magenta(`${Date.now() - started} ms`)}`);

		const bom = require('gulp-bom') as typeof import('gulp-bom');
		const sourcemaps = require('gulp-sourcemaps') as typeof import('gulp-sourcemaps');
		const isUtf8Test = (f: File) => /(\/|\\)test(\/|\\).*utf8/.test(f.path);
		const cycles = new ImportCycleCollector(srcRoot);
		const emitted = gulp.src(`${emitDir}/**/*.js`, { base: emitDir })
			// only modules compiled from TypeScript; .js under src is copied below as it is
			.pipe(util.filter(file => fs.existsSync(path.join(srcRoot, file.relative.replace(/\.js$/, '.ts')))))
			.pipe(es.map<File & { sourceMap?: RawSourceMap }, File | undefined>((file, cb): File | undefined => {
				fs.readFile(`${file.path}.map`, 'utf8', (err, text) => {
					if (err) {
						cb(err);
						return;
					}
					const map = JSON.parse(text) as RawSourceMap;
					delete map.sourceRoot;
					file.sourceMap = map;
					cycles.add(file);
					cb(undefined, file);
				});
				return undefined;
			}))
			.pipe(nls.nls({ preserveEnglish: options.preserveEnglish }))
			.pipe(sourcemaps.write('.', { addComment: false, includeContent: true, sourceRoot: util.toFileUri(srcRoot) }));
		const resources = gulp.src([`${src}/**`, `!${src}/**/*.ts`], { base: src, nodir: true })
			.pipe(generator.stream);
		await new Promise<void>((resolve, reject) => {
			es.merge(emitted, resources)
				.pipe(util.$if(isUtf8Test, bom()))
				.pipe(gulp.dest(out))
				.on('error', reject)
				.on('finish', () => resolve());
		});

		const errors = [...typeErrors, ...cycles.errors()];
		for (const error of errors) {
			fancyLog(ansiColors.red('Error'), error);
		}
		fancyLog(`Finished compilation (tsgo) with ${errors.length} errors after ${ansiColors.magenta(`${Date.now() - started} ms`)}`);
		if (errors.length && !options.ignoreTypeErrors) {
			throw new Error(`Found ${errors.length} errors`);
		}
	};
}

/** Runs tsgo on the project with extra arguments; resolves with one entry per diagnostic. */
function runTsgo(projectPath: string, args: string[]): Promise<string[]> {
	const cp = require('child_process') as typeof import('child_process');
	const root = path.join(__dirname, '../..');
	const tsgo = path.join(path.dirname(require.resolve('@typescript/native-preview/package.json', { paths: [root] })), 'bin', 'tsgo');
	return new Promise(resolve => {
		const child = cp.spawn(process.execPath, [tsgo, '--project', projectPath, '--skipLibCheck', '--pretty', 'false', ...args], { cwd: root });
		let output = '';
		child.stdout.on('data', chunk => output += chunk);
		child.stderr.on('data', chunk => output += chunk);
		child.on('error', err => resolve([`tsgo failed to start: ${err.message}`]));
		child.on('close', code => {
			const errors: string[] = [];
			for (const line of output.split(/\r?\n/)) {
				if (/^\S.*\(\d+,\d+\): error /.test(line) || /^error /.test(line)) {
					errors.push(line);
				} else if (errors.length && /^\s+\S/.test(line)) {
					errors[errors.length - 1] += `\n${line}`;
				}
			}
			if (code && !errors.length) {
				errors.push(`tsgo exited with ${code}: ${output.trim().slice(0, 2000)}`);
			}
			resolve(errors);
		});
	});
}

/** Relative-import cycles between emitted modules (type-only imports are gone), as the TypeScript builder checks after emit. */
class ImportCycleCollector {
	private readonly sources = new Map<string, string>();

	constructor(private readonly root: string) { }

	add(file: File): void {
		if (file.contents && /\.js$/.test(file.path)) {
			this.sources.set(path.join(this.root, file.relative), file.contents.toString());
		}
	}

	errors(): string[] {
		const tsutils = require('./tsb/utils') as typeof import('./tsb/utils');
		const graph = new tsutils.graph.Graph<string>();
		for (const [file, text] of this.sources) {
			graph.lookupOrInsertNode(file);
			for (const ref of ts.preProcessFile(text, true).importedFiles) {
				if (!ref.fileName.startsWith('.') || ref.fileName.endsWith('.css')) {
					continue;
				}
				const base = path.resolve(path.dirname(file), ref.fileName.replace(/\.js$/, ''));
				const target = [`${base}.js`, path.join(base, 'index.js')].find(candidate => this.sources.has(candidate));
				if (target) {
					graph.inertEdge(file, target);
				}
			}
		}
		const errors: string[] = [];
		for (const [, cycle] of graph.findCycles([...this.sources.keys()].sort((a, b) => a.localeCompare(b)))) {
			if (cycle) {
				errors.push(`CYCLIC dependency: ${cycle.map(file => path.relative(this.root, file).replace(/\.js$/, '.ts')).join(' -> ')}`);
			}
		}
		return errors;
	}
}

export function watchTask(out: string, build: boolean, srcPath: string = 'src'): task.StreamTask {

	const task = () => {
		const engine = resolveDevTranspileEngine();
		const compile = createCompile(srcPath, { build, emitError: false, transpileOnly: isFastTranspileEngine(engine) ? { engine } : false, preserveEnglish: false });

		const src = gulp.src(`${srcPath}/**`, { base: srcPath });
		const watchSrc = watch(`${srcPath}/**`, { base: srcPath, readDelay: 50 });

		const generator = new MonacoGenerator(true);
		generator.execute();

		return watchSrc
			.pipe(generator.stream)
			.pipe(util.incremental(compile, src, true))
			.pipe(gulp.dest(out));
	};
	task.taskName = `watch-${path.basename(out)}`;
	return task;
}

const REPO_SRC_FOLDER = path.join(__dirname, '../../src');

class MonacoGenerator {
	private readonly _isWatch: boolean;
	public readonly stream: NodeJS.ReadWriteStream;

	private readonly _watchedFiles: { [filePath: string]: boolean };
	private readonly _fsProvider: monacodts.FSProvider;
	private readonly _declarationResolver: monacodts.DeclarationResolver;

	constructor(isWatch: boolean) {
		this._isWatch = isWatch;
		this.stream = es.through();
		this._watchedFiles = {};
		const onWillReadFile = (moduleId: string, filePath: string) => {
			if (!this._isWatch) {
				return;
			}
			if (this._watchedFiles[filePath]) {
				return;
			}
			this._watchedFiles[filePath] = true;

			fs.watchFile(filePath, () => {
				this._declarationResolver.invalidateCache(moduleId);
				this._executeSoon();
			});
		};
		this._fsProvider = new class extends monacodts.FSProvider {
			public readFileSync(moduleId: string, filePath: string): Buffer {
				onWillReadFile(moduleId, filePath);
				return super.readFileSync(moduleId, filePath);
			}
		};
		this._declarationResolver = new monacodts.DeclarationResolver(this._fsProvider);

		if (this._isWatch) {
			fs.watchFile(monacodts.RECIPE_PATH, () => {
				this._executeSoon();
			});
		}
	}

	private _executeSoonTimer: NodeJS.Timeout | null = null;
	private _executeSoon(): void {
		if (this._executeSoonTimer !== null) {
			clearTimeout(this._executeSoonTimer);
			this._executeSoonTimer = null;
		}
		this._executeSoonTimer = setTimeout(() => {
			this._executeSoonTimer = null;
			this.execute();
		}, 20);
	}

	private _run(): monacodts.IMonacoDeclarationResult | null {
		const r = monacodts.run3(this._declarationResolver);
		if (!r && !this._isWatch) {
			// The build must always be able to generate the monaco.d.ts
			throw new Error(`monaco.d.ts generation error - Cannot continue`);
		}
		return r;
	}

	private _log(message: any, ...rest: any[]): void {
		fancyLog(ansiColors.cyan('[monaco.d.ts]'), message, ...rest);
	}

	public execute(): void {
		const startTime = Date.now();
		const result = this._run();
		if (!result) {
			// nothing really changed
			return;
		}
		if (result.isTheSame) {
			return;
		}

		fs.writeFileSync(result.filePath, result.content);
		fs.writeFileSync(path.join(REPO_SRC_FOLDER, 'vs/editor/common/standalone/standaloneEnums.ts'), result.enums);
		this._log(`monaco.d.ts is changed - total time took ${Date.now() - startTime} ms`);
		if (!this._isWatch) {
			this.stream.emit('error', 'monaco.d.ts is no longer up to date. Please run gulp watch and commit the new file.');
		}
	}
}

function generateApiProposalNames() {
	let eol: string;

	try {
		const src = fs.readFileSync('src/vs/platform/extensions/common/extensionsApiProposals.ts', 'utf-8');
		const match = /\r?\n/m.exec(src);
		eol = match ? match[0] : os.EOL;
	} catch {
		eol = os.EOL;
	}

	const pattern = /vscode\.proposed\.([a-zA-Z\d]+)\.d\.ts$/;
	const versionPattern = /^\s*\/\/\s*version\s*:\s*(\d+)\s*$/mi;
	const proposals = new Map<string, { proposal: string; version?: number }>();

	const input = es.through();
	const output = input
		.pipe(util.filter((f: File) => pattern.test(f.path)))
		.pipe(es.through((f: File) => {
			const name = path.basename(f.path);
			const match = pattern.exec(name);

			if (!match) {
				return;
			}

			const proposalName = match[1];

			const contents = f.contents!.toString('utf8');
			const versionMatch = versionPattern.exec(contents);
			const version = versionMatch ? versionMatch[1] : undefined;

			proposals.set(proposalName, {
				proposal: `https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.${proposalName}.d.ts`,
				version: version ? parseInt(version) : undefined
			});
		}, function () {
			const names = [...proposals.keys()].sort();
			const contents = [
				'/*---------------------------------------------------------------------------------------------',
				' *  Copyright (c) Microsoft Corporation. All rights reserved.',
				' *  Licensed under the MIT License. See License.txt in the project root for license information.',
				' *--------------------------------------------------------------------------------------------*/',
				'',
				'// THIS IS A GENERATED FILE. DO NOT EDIT DIRECTLY.',
				'',
				'const _allApiProposals = {',
				`${names.map(proposalName => {
					const proposal = proposals.get(proposalName)!;
					return `\t${proposalName}: {${eol}\t\tproposal: '${proposal.proposal}',${eol}${proposal.version ? `\t\tversion: ${proposal.version}${eol}` : ''}\t}`;
				}).join(`,${eol}`)}`,
				'};',
				'export const allApiProposals = Object.freeze<{ [proposalName: string]: Readonly<{ proposal: string; version?: number }> }>(_allApiProposals);',
				'export type ApiProposalName = keyof typeof _allApiProposals;',
				'',
			].join(eol);

			this.emit('data', new File({
				path: 'vs/platform/extensions/common/extensionsApiProposals.ts',
				contents: Buffer.from(contents)
			}));
			this.emit('end');
		}));

	return es.duplex(input, output);
}

const apiProposalNamesReporter = createReporter('api-proposal-names');

export const compileApiProposalNamesTask = task.define('compile-api-proposal-names', () => {
	return gulp.src('src/vscode-dts/**')
		.pipe(generateApiProposalNames())
		.pipe(gulp.dest('src'))
		.pipe(apiProposalNamesReporter.end(true));
});

export const watchApiProposalNamesTask = task.define('watch-api-proposal-names', () => {
	const task = () => gulp.src('src/vscode-dts/**')
		.pipe(generateApiProposalNames())
		.pipe(apiProposalNamesReporter.end(true));

	return watch('src/vscode-dts/**', { readDelay: 200 })
		.pipe(util.debounce(task))
		.pipe(gulp.dest('src'));
});
