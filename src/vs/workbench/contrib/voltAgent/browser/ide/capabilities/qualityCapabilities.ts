/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IMarkerData, IMarkerService, MarkerSeverity } from '../../../../../../platform/markers/common/markers.js';
import { COVERAGE_REPORT_FILES, IFileCoverageSummary, lineRanges, parseCoverage } from '../../../../../services/voltRuntime/common/ide/coverageReports.js';
import { stripAnsi } from '../../../../../services/voltRuntime/common/ide/testReports.js';
import { display, fail, IIdeCapability, IIdeCapabilityContext, IIdeCapabilityResult, list, ok, resolvePath, str } from './capability.js';

/** The newest coverage report in the project, summarized; per file, the lines that never ran. */
export class CoverageCapability implements IIdeCapability {

	readonly id = 'coverage';

	constructor(private readonly fileService: IFileService) { }

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		if (op !== 'report') {
			return fail(`coverage has no op ${op}.`);
		}
		if (!ctx.root) {
			return fail('No workspace folder.');
		}
		let newest: { uri: URI; mtime: number; name: string } | undefined;
		for (const name of COVERAGE_REPORT_FILES) {
			const uri = joinPath(ctx.root, name);
			const stat = await this.fileService.stat(uri).catch(() => undefined);
			if (stat && (!newest || stat.mtime > newest.mtime)) {
				newest = { uri, mtime: stat.mtime, name };
			}
		}
		if (!newest) {
			return fail('No coverage report found (coverage/coverage-final.json, lcov.info, coverage.xml, coverage.out). Run tests with coverage first: tests op run coverage: true, or the project\'s coverage script.');
		}
		const files = parseCoverage(newest.name, (await this.fileService.readFile(newest.uri)).value.toString());
		const covered = files.reduce((sum, file) => sum + file.covered, 0);
		const total = files.reduce((sum, file) => sum + file.total, 0);
		const pct = (file: Pick<IFileCoverageSummary, 'covered' | 'total'>) => file.total ? (file.covered / file.total) * 100 : 100;
		const age = Math.round((Date.now() - newest.mtime) / 60_000);
		const shortPath = (path: string) => display(ctx.root, resolvePath(ctx.root, path) ?? URI.file(path));
		const lines = [`${newest.name} (${age < 1 ? 'just now' : `${age} min old`}): ${pct({ covered, total }).toFixed(1)}% of ${total} lines in ${files.length} files.`];
		const wanted = str(args, 'path');
		if (wanted) {
			const target = resolvePath(ctx.root, wanted);
			const file = files.find(item => target && (resolvePath(ctx.root, item.path)?.toString() === target.toString() || item.path.endsWith(wanted)));
			if (!file) {
				return ok(`${lines[0]}\n${wanted} is not in the report (it never loaded during the tests, or it is excluded).`);
			}
			lines.push(`${shortPath(file.path)}: ${pct(file).toFixed(1)}% (${file.covered}/${file.total}). Uncovered lines: ${lineRanges(file.uncovered) || 'none'}.`);
			return ok(lines.join('\n'));
		}
		const least = files.filter(file => file.total >= 5).sort((a, b) => pct(a) - pct(b)).slice(0, 15);
		lines.push('Least covered:', ...least.map(file => `  ${pct(file).toFixed(0).padStart(3)}%  ${shortPath(file.path)}  (${file.total - file.covered} uncovered lines)`));
		return ok(lines.join('\n'));
	}
}

interface IAnalyzer {
	readonly id: string;
	detect(ctx: IIdeCapabilityContext, has: (path: string) => Promise<boolean>): Promise<boolean>;
	run(ctx: IIdeCapabilityContext, paths: readonly string[], has: (path: string) => Promise<boolean>): Promise<{ readonly markers: readonly IAnalyzerFinding[]; readonly error?: string }>;
}

interface IAnalyzerFinding {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly severity: 'error' | 'warning' | 'info';
	readonly message: string;
	readonly rule?: string;
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

const ANALYZERS: readonly IAnalyzer[] = [
	{
		id: 'eslint',
		detect: async (_ctx, has) => has('node_modules/.bin/eslint'),
		run: async (ctx, paths) => {
			const result = await ctx.cli.run(joinPath(ctx.root!, 'node_modules/.bin/eslint').fsPath, ['-f', 'json', ...(paths.length ? paths : ['.'])], { timeoutMs: 300_000 });
			const json = parseJson<{ filePath: string; messages: { line?: number; column?: number; severity: number; message: string; ruleId?: string }[] }[]>(result.stdout);
			return json ? { markers: json.flatMap(file => file.messages.map(message => ({ file: file.filePath, line: message.line ?? 1, column: message.column ?? 1, severity: message.severity === 2 ? 'error' as const : 'warning' as const, message: message.message, ...(message.ruleId ? { rule: message.ruleId } : {}) }))) } : { markers: [], error: stripAnsi(result.stderr || result.stdout).slice(0, 2_000) };
		},
	},
	{
		id: 'tsc',
		detect: async (_ctx, has) => await has('tsconfig.json') && await has('node_modules/.bin/tsc'),
		run: async ctx => {
			const result = await ctx.cli.run(joinPath(ctx.root!, 'node_modules/.bin/tsc').fsPath, ['--noEmit', '--pretty', 'false', '-p', '.'], { timeoutMs: 600_000 });
			const markers = [...result.stdout.matchAll(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/gm)].map(match => ({ file: match[1], line: Number(match[2]), column: Number(match[3]), severity: match[4] === 'error' ? 'error' as const : 'warning' as const, message: match[6], rule: match[5] }));
			return { markers };
		},
	},
	{
		id: 'ruff',
		detect: async (ctx, has) => (await has('pyproject.toml') || await has('ruff.toml')) && !(await ctx.cli.run('ruff', ['--version'], { timeoutMs: 10_000 })).missing,
		run: async (ctx, paths) => {
			const result = await ctx.cli.run('ruff', ['check', '--output-format', 'json', ...(paths.length ? paths : ['.'])], { timeoutMs: 300_000 });
			const json = parseJson<{ filename: string; location: { row: number; column: number }; code: string; message: string }[]>(result.stdout);
			return json ? { markers: json.map(item => ({ file: item.filename, line: item.location.row, column: item.location.column, severity: 'warning' as const, message: item.message, rule: item.code })) } : { markers: [], error: result.stderr.slice(0, 2_000) };
		},
	},
	{
		id: 'mypy',
		detect: async (ctx, has) => (await has('mypy.ini') || await has('.mypy.ini')) && !(await ctx.cli.run('mypy', ['--version'], { timeoutMs: 10_000 })).missing,
		run: async (ctx, paths) => {
			const result = await ctx.cli.run('mypy', ['--show-column-numbers', '--no-error-summary', ...(paths.length ? paths : ['.'])], { timeoutMs: 600_000 });
			return { markers: [...result.stdout.matchAll(/^(.+?):(\d+):(\d+): (error|warning|note): (.+?)(?:\s+\[([\w-]+)\])?$/gm)].map(match => ({ file: match[1], line: Number(match[2]), column: Number(match[3]), severity: match[4] === 'error' ? 'error' as const : match[4] === 'warning' ? 'warning' as const : 'info' as const, message: match[5], ...(match[6] ? { rule: match[6] } : {}) })) };
		},
	},
	{
		id: 'semgrep',
		// Only with rules in the repo: `--config auto` would send code metadata to the registry.
		detect: async (ctx, has) => (await has('.semgrep.yml') || await has('.semgrep.yaml')) && !(await ctx.cli.run('semgrep', ['--version'], { timeoutMs: 10_000 })).missing,
		run: async (ctx, paths, has) => {
			const config = await has('.semgrep.yml') ? '.semgrep.yml' : '.semgrep.yaml';
			const result = await ctx.cli.run('semgrep', ['--json', '--config', config, '--metrics', 'off', ...(paths.length ? paths : ['.'])], { timeoutMs: 600_000 });
			const json = parseJson<{ results: { path: string; start: { line: number; col: number }; check_id: string; extra: { message: string; severity: string } }[] }>(result.stdout);
			return json ? { markers: json.results.map(item => ({ file: item.path, line: item.start.line, column: item.start.col, severity: item.extra.severity === 'ERROR' ? 'error' as const : 'warning' as const, message: item.extra.message, rule: item.check_id })) } : { markers: [], error: result.stderr.slice(0, 2_000) };
		},
	},
	{
		id: 'golangci-lint',
		detect: async (ctx, has) => await has('go.mod') && !(await ctx.cli.run('golangci-lint', ['--version'], { timeoutMs: 10_000 })).missing,
		run: async ctx => {
			const result = await ctx.cli.run('golangci-lint', ['run', '--out-format', 'json'], { timeoutMs: 600_000 });
			const json = parseJson<{ Issues: { FromLinter: string; Text: string; Pos: { Filename: string; Line: number; Column: number } }[] | null }>(result.stdout);
			return json ? { markers: (json.Issues ?? []).map(item => ({ file: item.Pos.Filename, line: item.Pos.Line, column: item.Pos.Column, severity: 'warning' as const, message: item.Text, rule: item.FromLinter })) } : { markers: [], error: result.stderr.slice(0, 2_000) };
		},
	},
	{
		id: 'clippy',
		detect: async (_ctx, has) => has('Cargo.toml'),
		run: async ctx => {
			const result = await ctx.cli.run('cargo', ['clippy', '--message-format=json', '--quiet'], { timeoutMs: 900_000 });
			const markers: IAnalyzerFinding[] = [];
			for (const line of result.stdout.split('\n')) {
				const item = line.startsWith('{') ? parseJson<{ reason: string; message?: { message: string; level: string; code?: { code: string }; spans: { file_name: string; line_start: number; column_start: number; is_primary: boolean }[] } }>(line) : undefined;
				const span = item?.reason === 'compiler-message' ? item.message?.spans.find(candidate => candidate.is_primary) : undefined;
				if (item?.message && span) {
					markers.push({ file: span.file_name, line: span.line_start, column: span.column_start, severity: item.message.level === 'error' ? 'error' : 'warning', message: item.message.message, ...(item.message.code ? { rule: item.message.code.code } : {}) });
				}
			}
			return { markers };
		},
	},
];

/** The project's own analyzers, findings published to the Problems view under "volt-analyze/<tool>". */
export class AnalyzeCapability implements IIdeCapability {

	readonly id = 'analyze';

	constructor(private readonly fileService: IFileService, private readonly markerService: IMarkerService) { }

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		if (!ctx.root) {
			return fail('No workspace folder.');
		}
		const has = (path: string) => this.fileService.exists(joinPath(ctx.root!, path));
		const detected: IAnalyzer[] = [];
		for (const analyzer of ANALYZERS) {
			if (await analyzer.detect(ctx, has).catch(() => false)) {
				detected.push(analyzer);
			}
		}
		if (op === 'tools') {
			return ok(detected.length ? `Analyzers here: ${detected.map(item => item.id).join(', ')}.` : 'No supported analyzer found (eslint, tsc, ruff, mypy, semgrep with .semgrep.yml, golangci-lint, clippy).');
		}
		if (op !== 'run') {
			return fail(`analyze has no op ${op}.`);
		}
		const tool = str(args, 'tool');
		const chosen = tool ? detected.filter(item => item.id === tool) : detected;
		if (!chosen.length) {
			return fail(tool ? `${tool} is not set up in this project. Detected: ${detected.map(item => item.id).join(', ') || 'none'}.` : 'No analyzer detected. Use op tools to see what is supported.');
		}
		const paths = list(args, 'paths');
		const out: string[] = [];
		for (const analyzer of chosen) {
			const { markers, error } = await analyzer.run(ctx, paths, has).catch(err => ({ markers: [] as IAnalyzerFinding[], error: err instanceof Error ? err.message : String(err) }));
			this.publish(ctx.root, analyzer.id, markers);
			if (error && !markers.length) {
				out.push(`${analyzer.id}: failed: ${error.trim().split('\n').slice(0, 8).join('\n')}`);
				continue;
			}
			const errors = markers.filter(item => item.severity === 'error').length;
			out.push(`${analyzer.id}: ${errors} error${errors === 1 ? '' : 's'}, ${markers.length - errors} other`);
			const byFile = new Map<string, IAnalyzerFinding[]>();
			for (const item of markers) {
				byFile.set(item.file, [...(byFile.get(item.file) ?? []), item]);
			}
			let shown = 0;
			for (const [file, items] of byFile) {
				if (shown >= 60) {
					out.push(`  [${markers.length - shown} more in the Problems view]`);
					break;
				}
				out.push(`  ${display(ctx.root, resolvePath(ctx.root, file) ?? URI.file(file))}`);
				for (const item of items.slice(0, 8)) {
					out.push(`    ${item.line}:${item.column} ${item.severity}${item.rule ? ` ${item.rule}` : ''}: ${item.message.split('\n')[0].slice(0, 200)}`);
					shown++;
				}
			}
		}
		return ok(out.join('\n'));
	}

	private publish(root: URI, tool: string, findings: readonly IAnalyzerFinding[]): void {
		const byFile = new Map<string, IMarkerData[]>();
		for (const item of findings) {
			const uri = resolvePath(root, item.file);
			if (!uri) {
				continue;
			}
			const key = uri.toString();
			byFile.set(key, [...(byFile.get(key) ?? []), {
				severity: item.severity === 'error' ? MarkerSeverity.Error : item.severity === 'warning' ? MarkerSeverity.Warning : MarkerSeverity.Info,
				message: item.message,
				startLineNumber: item.line,
				startColumn: item.column,
				endLineNumber: item.line,
				endColumn: item.column + 1,
				source: tool,
				...(item.rule ? { code: item.rule } : {}),
			}]);
		}
		this.markerService.changeAll(`volt-analyze/${tool}`, [...byFile].map(([resource, markers]) => markers.map(marker => ({ resource: URI.parse(resource), marker }))).flat());
	}
}
