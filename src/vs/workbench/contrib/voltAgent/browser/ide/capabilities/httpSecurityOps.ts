/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { HTTP_SECURITY_SEVERITY_LABELS, httpSecurityEndpointLabel, httpSecurityFindingText, httpSecurityMarkdownReport, IHttpSecurityFinding, isHttpSecurityFindingOpen, sortHttpSecurityFindings, summarizeHttpSecurity } from '../../../../voltHttp/common/httpSecurity.js';
import { httpSecurityCountsText, IHttpSecurityEntry, IVoltHttpSecurity } from '../../../../voltHttp/browser/voltHttpSecurity.js';
import { display, fail, IIdeCapabilityContext, IIdeCapabilityResult, num, ok, resolvePath, str } from './capability.js';

const SECURITY_OPS = new Set(['security_list', 'security_get', 'security_save', 'security_scan', 'security_report']);
const MAX_REPORT_CHARS = 24_000;
const TOP_FINDINGS = 10;

/** Why an op that sends requests is refused for this chat, or undefined. */
function scanRefusal(ctx: IIdeCapabilityContext): string | undefined {
	return ctx.confinement ? 'A sandboxed chat cannot run security scans: they send requests from Volt\'s process, outside the chat\'s network rules. Ask the user to run the scan in the Volt Client.' : undefined;
}

/** The scan file an op names with `path` (a path or a scan's name), or the project's only one. */
async function scanFile(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext, security: IVoltHttpSecurity): Promise<IHttpSecurityEntry> {
	const raw = str(args, 'path') ?? str(args, 'scan');
	const files = await security.list(ctx.root);
	let uri: URI | undefined;
	if (raw) {
		const resolved = resolvePath(ctx.root, raw);
		uri = files.find(item => resolved && item.uri.toString() === resolved.toString())?.uri ?? files.find(item => item.name === raw)?.uri ?? resolved;
	} else if (files.length === 1) {
		uri = files[0].uri;
	} else {
		throw new Error(files.length ? `Say which scan with path. The project has: ${files.map(item => display(ctx.root, item.uri)).join(', ')}.` : 'The project has no security scans yet. op security_save creates one.');
	}
	const entry = uri ? await security.load(uri) : undefined;
	if (!entry) {
		throw new Error(`No security scan at "${raw}". op security_list shows the project's scans.`);
	}
	if (entry.error) {
		throw new Error(`${display(ctx.root, entry.uri)} could not be read: ${entry.error}`);
	}
	return entry;
}

function findingLine(finding: IHttpSecurityFinding, triage?: string): string {
	return `- [${HTTP_SECURITY_SEVERITY_LABELS[finding.severity]}, ${finding.confidence}] ${finding.title}: ${httpSecurityEndpointLabel(finding.endpoint)}${finding.parameter ? ` (${finding.parameter})` : ''} ${finding.owasp}${triage ? ` - triaged: ${triage}` : ''} {${finding.fingerprint}}`;
}

/**
 * The `ide http security_*` ops: security scans of the project's own APIs. Agents can read, define,
 * run (passive checks; active ones only when the user already authorized every host in the Volt
 * Client) and report scans. They can never authorize a host or triage a finding.
 * Answers undefined for an op that is not one of these.
 */
export async function runHttpSecurityOp(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext, security: IVoltHttpSecurity): Promise<IIdeCapabilityResult | undefined> {
	if (!SECURITY_OPS.has(op)) {
		return undefined;
	}
	try {
		switch (op) {
			case 'security_list': {
				const files = await security.list(ctx.root);
				if (!files.length) {
					return ok('No security scans in the project (*.volt-security.json). op security_save creates one from { name, targets: [{ collection, path? }], checks?, options? }.');
				}
				return ok(files.map(item => `${display(ctx.root, item.uri)}  "${item.name}"  ${item.running ? 'scanning now' : item.detail ?? ''}`).join('\n'));
			}
			case 'security_get': {
				const entry = await scanFile(args, ctx, security);
				const file = entry.file;
				const fingerprint = str(args, 'finding');
				const findings = security.scanOf(entry.uri)?.findings ?? file.lastScan?.findings ?? [];
				if (fingerprint) {
					const finding = findings.find(item => item.fingerprint === fingerprint || item.id === fingerprint);
					return finding ? ok(httpSecurityFindingText(finding, file.triage[finding.fingerprint])) : fail(`No finding ${fingerprint} in the last scan. op security_get without finding lists them.`);
				}
				const summary = file.lastScan ? summarizeHttpSecurity(file.lastScan.findings, file.triage) : undefined;
				return ok(JSON.stringify({
					path: display(ctx.root, entry.uri),
					name: file.name,
					description: file.description,
					targets: file.targets,
					checks: file.checks,
					options: file.options,
					// What the user authorized in this Volt; a host only written into the file does not count.
					authorizedHosts: security.authorizedHostsOf(entry.uri).map(item => item.host),
					lastScan: file.lastScan && summary ? {
						at: file.lastScan.at,
						requests: file.lastScan.requests,
						probes: file.lastScan.probes,
						active: file.lastScan.active,
						notes: file.lastScan.notes ?? [],
						score: summary.score,
						grade: summary.grade,
						open: httpSecurityCountsText(file.lastScan.findings, file.triage),
						findings: sortHttpSecurityFindings(file.lastScan.findings).map(finding => findingLine(finding, file.triage[finding.fingerprint]).slice(2)),
					} : null,
				}, null, 2));
			}
			case 'security_save': {
				const raw = args.definition ?? args.scan_definition ?? args.json;
				let definition: unknown = raw;
				if (typeof raw === 'string') {
					try {
						definition = JSON.parse(raw);
					} catch {
						return fail('definition is not valid JSON.');
					}
				}
				if (definition === undefined) {
					const { path: _path, ...rest } = args;
					definition = rest;
				}
				const target = str(args, 'path');
				const uri = target ? resolvePath(ctx.root, target) : undefined;
				if (ctx.confinement) {
					const check = uri ?? ctx.root;
					const refused = check && ctx.confinement.writeRefusal ? await ctx.confinement.writeRefusal(check.fsPath) : 'Volt cannot tell whether this sandboxed chat may write the scan file';
					if (refused) {
						return fail(`Not saved: ${refused}.`);
					}
				}
				const saved = await security.saveDefinition(ctx.root, definition, uri && await security.load(uri) ? uri : undefined);
				const asRecord = typeof definition === 'object' && definition !== null ? definition as Record<string, unknown> : {};
				const ignored = ['authorizedHosts', 'triage', 'lastScan'].filter(key => key in asRecord);
				return ok([
					`Saved ${display(ctx.root, saved)}.`,
					...(ignored.length ? [`Ignored ${ignored.join(', ')}: only the user sets those, in the Volt Client.`] : []),
					'Active checks run only after the user ticks "I own this API or have permission to test it" for each host under Setup, Active checks.',
				].join('\n'));
			}
			case 'security_scan': {
				const refused = scanRefusal(ctx);
				if (refused) {
					return fail(refused);
				}
				const entry = await scanFile(args, ctx, security);
				const passiveOnly = args.active === false || args.active === 'false' || str(args, 'mode') === 'passive';
				const state = await security.scan(entry.uri, { ...(ctx.root ? { root: ctx.root } : {}), ...(passiveOnly ? { active: false } : {}), token: ctx.token });
				if (state.error) {
					return fail(`The scan failed: ${state.error}`);
				}
				const file = security.get(entry.uri)?.file ?? entry.file;
				const summary = summarizeHttpSecurity(state.findings, file.triage);
				const open = sortHttpSecurityFindings(state.findings.filter(finding => isHttpSecurityFindingOpen(finding, file.triage)));
				const limit = Math.max(1, Math.min(50, num(args, 'top') ?? TOP_FINDINGS));
				return ok([
					`${file.name}: ${state.requests} of ${state.total} requests scanned, ${state.probes} probes sent (${state.active ? 'passive and active checks' : 'passive checks only'})${state.stopped ? ', stopped before the end' : ''}.`,
					`Score ${summary.score}/100 (${summary.grade}). Open: ${httpSecurityCountsText(state.findings, file.triage)}.`,
					...(state.notes.length ? ['', 'Notes:', ...state.notes.map(note => `- ${note}`)] : []),
					...(!state.active && !file.options.active ? ['', 'Only passive checks ran: the scan\'s options.active is off. Active checks also need the user to authorize every host in the Volt Client.'] : []),
					'',
					open.length ? `Top findings (op security_get with finding=<id> shows one with its evidence):` : 'No open findings.',
					...open.slice(0, limit).map(finding => findingLine(finding)),
					...(open.length > limit ? [`- and ${open.length - limit} more (op security_report)`] : []),
				].join('\n'));
			}
			case 'security_report': {
				const entry = await scanFile(args, ctx, security);
				const report = httpSecurityMarkdownReport(entry.file);
				return ok(report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS)}\n\n[${report.length - MAX_REPORT_CHARS} more characters: export the full report from the Volt Client, or read single findings with op security_get finding=<id>]` : report);
			}
		}
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
	return undefined;
}
