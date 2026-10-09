"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.watchApiProposalNamesTask = exports.compileApiProposalNamesTask = void 0;
exports.createCompile = createCompile;
exports.transpileTask = transpileTask;
exports.compileTask = compileTask;
exports.watchTask = watchTask;
const event_stream_1 = __importDefault(require("event-stream"));
const fs_1 = __importDefault(require("fs"));
const gulp_1 = __importDefault(require("gulp"));
const path_1 = __importDefault(require("path"));
const monacodts = __importStar(require("./monaco-api"));
const nls = __importStar(require("./nls"));
const reporter_1 = require("./reporter");
const util = __importStar(require("./util"));
const fancy_log_1 = __importDefault(require("fancy-log"));
const ansi_colors_1 = __importDefault(require("ansi-colors"));
const os_1 = __importDefault(require("os"));
const vinyl_1 = __importDefault(require("vinyl"));
const task = __importStar(require("./task"));
const index_1 = require("./mangle/index");
const ts = require("typescript");
const devEngine_1 = require("./tsb/devEngine");
const watch = require('./watch');
// --- gulp-tsb: compile and transpile --------------------------------
const reporter = (0, reporter_1.createReporter)();
function getTypeScriptCompilerOptions(src) {
    const rootDir = path_1.default.join(__dirname, `../../${src}`);
    const options = {};
    options.verbose = false;
    options.sourceMap = true;
    if (process.env['VSCODE_NO_SOURCEMAP']) { // To be used by developers in a hurry
        options.sourceMap = false;
    }
    options.rootDir = rootDir;
    options.baseUrl = rootDir;
    options.sourceRoot = util.toFileUri(rootDir);
    options.newLine = /\r\n/.test(fs_1.default.readFileSync(__filename, 'utf8')) ? 0 : 1;
    return options;
}
function createCompile(src, { build, emitError, transpileOnly, preserveEnglish }) {
    const tsb = require('./tsb');
    const sourcemaps = require('gulp-sourcemaps');
    const projectPath = path_1.default.join(__dirname, '../../', src, 'tsconfig.json');
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
    function pipeline(token) {
        const bom = require('gulp-bom');
        const tsFilter = util.filter(data => /\.ts$/.test(data.path));
        const isUtf8Test = (f) => /(\/|\\)test(\/|\\).*utf8/.test(f.path);
        const isRuntimeJs = (f) => f.path.endsWith('.js') && !f.path.includes('fixtures');
        const noDeclarationsFilter = util.filter(data => !(/\.d\.ts$/.test(data.path)));
        const input = event_stream_1.default.through();
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
        return event_stream_1.default.duplex(input, output);
    }
    pipeline.tsProjectSrc = () => {
        return compilation.src({ base: src });
    };
    pipeline.projectPath = projectPath;
    return pipeline;
}
function transpileTask(src, out, esbuild) {
    const task = () => {
        const engine = esbuild ? 'esbuild' : (0, devEngine_1.resolveDevTranspileEngine)();
        const transpile = createCompile(src, { build: false, emitError: true, transpileOnly: { engine: (0, devEngine_1.isFastTranspileEngine)(engine) ? engine : 'oxc' }, preserveEnglish: false });
        const srcPipe = gulp_1.default.src(`${src}/**`, { base: `${src}` });
        return srcPipe
            .pipe(transpile())
            .pipe(gulp_1.default.dest(out));
    };
    task.taskName = `transpile-${path_1.default.basename(src)}`;
    return task;
}
function compileTask(src, out, build, options = {}) {
    // VOLT_BUILD_IGNORE_TYPE_ERRORS=1: report type errors but still package. Mangling needs a clean type check, so it is off too.
    const ignoreTypeErrors = !!process.env.VOLT_BUILD_IGNORE_TYPE_ERRORS;
    const mangle = build && !options.disableMangle && !ignoreTypeErrors;
    // Without mangling, product builds type-check and emit with tsgo (the native TypeScript
    // compiler, ~6 s for src); VOLT_BUILD_ENGINE=tsc keeps the single-threaded TypeScript
    // emitter. Mangling rewrites TypeScript through the language service, so it stays on tsc.
    if (build && !mangle && process.env.VOLT_BUILD_ENGINE !== 'tsc') {
        const fast = fastProductCompile(src, out, { ignoreTypeErrors, preserveEnglish: !!options.preserveEnglish });
        fast.taskName = `compile-${path_1.default.basename(src)}`;
        return fast;
    }
    const task = () => {
        if (os_1.default.totalmem() < 4_000_000_000) {
            throw new Error('compilation requires 4GB of RAM');
        }
        const compile = createCompile(src, { build, emitError: !ignoreTypeErrors, transpileOnly: false, preserveEnglish: !!options.preserveEnglish });
        const srcPipe = gulp_1.default.src(`${src}/**`, { base: `${src}` });
        const generator = new MonacoGenerator(false);
        if (src === 'src') {
            generator.execute();
        }
        // mangle: TypeScript to TypeScript
        let mangleStream = event_stream_1.default.through();
        if (mangle) {
            let ts2tsMangler = new index_1.Mangler(compile.projectPath, (...data) => (0, fancy_log_1.default)(ansi_colors_1.default.blue('[mangler]'), ...data), { mangleExports: true, manglePrivateFields: true });
            const newContentsByFileName = ts2tsMangler.computeNewFileContents(new Set(['saveState']));
            mangleStream = event_stream_1.default.through(async function write(data) {
                const tsNormalPath = ts.normalizePath(data.path);
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
                ts2tsMangler = undefined;
            });
        }
        return srcPipe
            .pipe(mangleStream)
            .pipe(generator.stream)
            .pipe(compile())
            .pipe(gulp_1.default.dest(out));
    };
    task.taskName = `compile-${path_1.default.basename(src)}`;
    return task;
}
/**
 * Product compile with tsgo: one native compiler run type-checks src and emits JavaScript and source
 * maps into a scratch folder (same output as the TypeScript emitter, const enums inlined), then the
 * usual steps run on it: NLS, source maps, resources, the import cycle check. Type errors and cycles
 * fail the task unless VOLT_BUILD_IGNORE_TYPE_ERRORS is set.
 */
function fastProductCompile(src, out, options) {
    return async () => {
        const started = Date.now();
        const root = path_1.default.join(__dirname, '../..');
        const srcRoot = path_1.default.join(root, src);
        const emitDir = path_1.default.join(root, '.build', `tsgo-${path_1.default.basename(out)}`);
        const generator = new MonacoGenerator(false);
        if (src === 'src') {
            generator.execute();
        }
        await fs_1.default.promises.rm(emitDir, { recursive: true, force: true });
        const typeErrors = await runTsgo(path_1.default.join(srcRoot, 'tsconfig.json'), [
            '--outDir', emitDir, '--rootDir', srcRoot, '--sourceMap', '--inlineSources',
            '--sourceRoot', util.toFileUri(srcRoot), '--newLine', 'lf', '--noEmitOnError', 'false',
        ]);
        (0, fancy_log_1.default)(`tsgo checked and emitted ${src} after ${ansi_colors_1.default.magenta(`${Date.now() - started} ms`)}`);
        const bom = require('gulp-bom');
        const sourcemaps = require('gulp-sourcemaps');
        const isUtf8Test = (f) => /(\/|\\)test(\/|\\).*utf8/.test(f.path);
        const cycles = new ImportCycleCollector(srcRoot);
        const emitted = gulp_1.default.src(`${emitDir}/**/*.js`, { base: emitDir })
            // only modules compiled from TypeScript; .js under src is copied below as it is
            .pipe(util.filter(file => fs_1.default.existsSync(path_1.default.join(srcRoot, file.relative.replace(/\.js$/, '.ts')))))
            .pipe(event_stream_1.default.map((file, cb) => {
            fs_1.default.readFile(`${file.path}.map`, 'utf8', (err, text) => {
                if (err) {
                    cb(err);
                    return;
                }
                const map = JSON.parse(text);
                delete map.sourceRoot;
                file.sourceMap = map;
                cycles.add(file);
                cb(undefined, file);
            });
            return undefined;
        }))
            .pipe(nls.nls({ preserveEnglish: options.preserveEnglish }))
            .pipe(sourcemaps.write('.', { addComment: false, includeContent: true, sourceRoot: util.toFileUri(srcRoot) }));
        const resources = gulp_1.default.src([`${src}/**`, `!${src}/**/*.ts`], { base: src, nodir: true })
            .pipe(generator.stream);
        await new Promise((resolve, reject) => {
            event_stream_1.default.merge(emitted, resources)
                .pipe(util.$if(isUtf8Test, bom()))
                .pipe(gulp_1.default.dest(out))
                .on('error', reject)
                .on('finish', () => resolve());
        });
        const errors = [...typeErrors, ...cycles.errors()];
        for (const error of errors) {
            (0, fancy_log_1.default)(ansi_colors_1.default.red('Error'), error);
        }
        (0, fancy_log_1.default)(`Finished compilation (tsgo) with ${errors.length} errors after ${ansi_colors_1.default.magenta(`${Date.now() - started} ms`)}`);
        if (errors.length && !options.ignoreTypeErrors) {
            throw new Error(`Found ${errors.length} errors`);
        }
    };
}
/** Runs tsgo on the project with extra arguments; resolves with one entry per diagnostic. */
function runTsgo(projectPath, args) {
    const cp = require('child_process');
    const root = path_1.default.join(__dirname, '../..');
    const tsgo = path_1.default.join(path_1.default.dirname(require.resolve('@typescript/native-preview/package.json', { paths: [root] })), 'bin', 'tsgo');
    return new Promise(resolve => {
        const child = cp.spawn(process.execPath, [tsgo, '--project', projectPath, '--skipLibCheck', '--pretty', 'false', ...args], { cwd: root });
        let output = '';
        child.stdout.on('data', chunk => output += chunk);
        child.stderr.on('data', chunk => output += chunk);
        child.on('error', err => resolve([`tsgo failed to start: ${err.message}`]));
        child.on('close', code => {
            const errors = [];
            for (const line of output.split(/\r?\n/)) {
                if (/^\S.*\(\d+,\d+\): error /.test(line) || /^error /.test(line)) {
                    errors.push(line);
                }
                else if (errors.length && /^\s+\S/.test(line)) {
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
    root;
    sources = new Map();
    constructor(root) {
        this.root = root;
    }
    add(file) {
        if (file.contents && /\.js$/.test(file.path)) {
            this.sources.set(path_1.default.join(this.root, file.relative), file.contents.toString());
        }
    }
    errors() {
        const tsutils = require('./tsb/utils');
        const graph = new tsutils.graph.Graph();
        for (const [file, text] of this.sources) {
            graph.lookupOrInsertNode(file);
            for (const ref of ts.preProcessFile(text, true).importedFiles) {
                if (!ref.fileName.startsWith('.') || ref.fileName.endsWith('.css')) {
                    continue;
                }
                const base = path_1.default.resolve(path_1.default.dirname(file), ref.fileName.replace(/\.js$/, ''));
                const target = [`${base}.js`, path_1.default.join(base, 'index.js')].find(candidate => this.sources.has(candidate));
                if (target) {
                    graph.inertEdge(file, target);
                }
            }
        }
        const errors = [];
        for (const [, cycle] of graph.findCycles([...this.sources.keys()].sort((a, b) => a.localeCompare(b)))) {
            if (cycle) {
                errors.push(`CYCLIC dependency: ${cycle.map(file => path_1.default.relative(this.root, file).replace(/\.js$/, '.ts')).join(' -> ')}`);
            }
        }
        return errors;
    }
}
function watchTask(out, build, srcPath = 'src') {
    const task = () => {
        const engine = (0, devEngine_1.resolveDevTranspileEngine)();
        const compile = createCompile(srcPath, { build, emitError: false, transpileOnly: (0, devEngine_1.isFastTranspileEngine)(engine) ? { engine } : false, preserveEnglish: false });
        const src = gulp_1.default.src(`${srcPath}/**`, { base: srcPath });
        const watchSrc = watch(`${srcPath}/**`, { base: srcPath, readDelay: 50 });
        const generator = new MonacoGenerator(true);
        generator.execute();
        return watchSrc
            .pipe(generator.stream)
            .pipe(util.incremental(compile, src, true))
            .pipe(gulp_1.default.dest(out));
    };
    task.taskName = `watch-${path_1.default.basename(out)}`;
    return task;
}
const REPO_SRC_FOLDER = path_1.default.join(__dirname, '../../src');
class MonacoGenerator {
    _isWatch;
    stream;
    _watchedFiles;
    _fsProvider;
    _declarationResolver;
    constructor(isWatch) {
        this._isWatch = isWatch;
        this.stream = event_stream_1.default.through();
        this._watchedFiles = {};
        const onWillReadFile = (moduleId, filePath) => {
            if (!this._isWatch) {
                return;
            }
            if (this._watchedFiles[filePath]) {
                return;
            }
            this._watchedFiles[filePath] = true;
            fs_1.default.watchFile(filePath, () => {
                this._declarationResolver.invalidateCache(moduleId);
                this._executeSoon();
            });
        };
        this._fsProvider = new class extends monacodts.FSProvider {
            readFileSync(moduleId, filePath) {
                onWillReadFile(moduleId, filePath);
                return super.readFileSync(moduleId, filePath);
            }
        };
        this._declarationResolver = new monacodts.DeclarationResolver(this._fsProvider);
        if (this._isWatch) {
            fs_1.default.watchFile(monacodts.RECIPE_PATH, () => {
                this._executeSoon();
            });
        }
    }
    _executeSoonTimer = null;
    _executeSoon() {
        if (this._executeSoonTimer !== null) {
            clearTimeout(this._executeSoonTimer);
            this._executeSoonTimer = null;
        }
        this._executeSoonTimer = setTimeout(() => {
            this._executeSoonTimer = null;
            this.execute();
        }, 20);
    }
    _run() {
        const r = monacodts.run3(this._declarationResolver);
        if (!r && !this._isWatch) {
            // The build must always be able to generate the monaco.d.ts
            throw new Error(`monaco.d.ts generation error - Cannot continue`);
        }
        return r;
    }
    _log(message, ...rest) {
        (0, fancy_log_1.default)(ansi_colors_1.default.cyan('[monaco.d.ts]'), message, ...rest);
    }
    execute() {
        const startTime = Date.now();
        const result = this._run();
        if (!result) {
            // nothing really changed
            return;
        }
        if (result.isTheSame) {
            return;
        }
        fs_1.default.writeFileSync(result.filePath, result.content);
        fs_1.default.writeFileSync(path_1.default.join(REPO_SRC_FOLDER, 'vs/editor/common/standalone/standaloneEnums.ts'), result.enums);
        this._log(`monaco.d.ts is changed - total time took ${Date.now() - startTime} ms`);
        if (!this._isWatch) {
            this.stream.emit('error', 'monaco.d.ts is no longer up to date. Please run gulp watch and commit the new file.');
        }
    }
}
function generateApiProposalNames() {
    let eol;
    try {
        const src = fs_1.default.readFileSync('src/vs/platform/extensions/common/extensionsApiProposals.ts', 'utf-8');
        const match = /\r?\n/m.exec(src);
        eol = match ? match[0] : os_1.default.EOL;
    }
    catch {
        eol = os_1.default.EOL;
    }
    const pattern = /vscode\.proposed\.([a-zA-Z\d]+)\.d\.ts$/;
    const versionPattern = /^\s*\/\/\s*version\s*:\s*(\d+)\s*$/mi;
    const proposals = new Map();
    const input = event_stream_1.default.through();
    const output = input
        .pipe(util.filter((f) => pattern.test(f.path)))
        .pipe(event_stream_1.default.through((f) => {
        const name = path_1.default.basename(f.path);
        const match = pattern.exec(name);
        if (!match) {
            return;
        }
        const proposalName = match[1];
        const contents = f.contents.toString('utf8');
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
                const proposal = proposals.get(proposalName);
                return `\t${proposalName}: {${eol}\t\tproposal: '${proposal.proposal}',${eol}${proposal.version ? `\t\tversion: ${proposal.version}${eol}` : ''}\t}`;
            }).join(`,${eol}`)}`,
            '};',
            'export const allApiProposals = Object.freeze<{ [proposalName: string]: Readonly<{ proposal: string; version?: number }> }>(_allApiProposals);',
            'export type ApiProposalName = keyof typeof _allApiProposals;',
            '',
        ].join(eol);
        this.emit('data', new vinyl_1.default({
            path: 'vs/platform/extensions/common/extensionsApiProposals.ts',
            contents: Buffer.from(contents)
        }));
        this.emit('end');
    }));
    return event_stream_1.default.duplex(input, output);
}
const apiProposalNamesReporter = (0, reporter_1.createReporter)('api-proposal-names');
exports.compileApiProposalNamesTask = task.define('compile-api-proposal-names', () => {
    return gulp_1.default.src('src/vscode-dts/**')
        .pipe(generateApiProposalNames())
        .pipe(gulp_1.default.dest('src'))
        .pipe(apiProposalNamesReporter.end(true));
});
exports.watchApiProposalNamesTask = task.define('watch-api-proposal-names', () => {
    const task = () => gulp_1.default.src('src/vscode-dts/**')
        .pipe(generateApiProposalNames())
        .pipe(apiProposalNamesReporter.end(true));
    return watch('src/vscode-dts/**', { readDelay: 200 })
        .pipe(util.debounce(task))
        .pipe(gulp_1.default.dest('src'));
});
//# sourceMappingURL=compilation.js.map