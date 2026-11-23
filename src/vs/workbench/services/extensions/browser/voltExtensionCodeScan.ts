/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler, timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { CodeScanRule, codeScanOptionsOf, ICodeScanFinding, ICodeScanReader, ICodeScanResult, scanExtensionFolder } from '../../../../platform/voltPlugins/common/extensionCodeScan.js';
import { firstPartyCeiling } from '../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWouldBeDenial } from '../../voltPlugins/common/capabilities.js';
import { IVoltExtensionApiService } from '../../voltPlugins/common/voltExtensionApi.js';
import { IExtensionService } from '../common/extensions.js';
import { IVoltExtensionSandboxService } from '../common/voltExtensionSandbox.js';

/**
 * What Volt tells the user about a third-party extension, beside the sandbox's own warnings (the
 * network broker and the OS refuse; this says what Volt saw):
 *
 * - at install: Volt reads the extension's shipped JavaScript once per version
 *   (`extensionCodeScan.ts`). The install sheet (`contrib/voltSecurity/browser/installSheet.ts`) lists
 *   the findings and offers the sandbox; code that hides what it does (a `high` finding) gets the
 *   sheet even when the extension declares no Volt capability.
 * - at runtime: a call through `vscode.volt` beyond what the extension declared (`manifest`), or one
 *   Volt never allows (`critical`, `catalog`), is refused by the extension API's policy; the user
 *   hears about it, once per extension and capability, instead of only the extension.
 */

export const IVoltExtensionCodeScanService = createDecorator<IVoltExtensionCodeScanService>('voltExtensionCodeScanService');

export interface IVoltExtensionCodeScanService {
	readonly _serviceBrand: undefined;
	/** An extension's code was scanned (or read from the cache). */
	readonly onDidScan: Event<{ readonly extension: IExtensionDescription; readonly result: ICodeScanResult }>;
	/** The scan of a third-party extension with code, once per version; undefined for built-ins and code-less ones. */
	scan(extension: IExtensionDescription): Promise<ICodeScanResult | undefined>;
}

/** Whether Volt scans it: an extension with code that does not ship with Volt. */
export function isScannedExtension(extension: Pick<IExtensionDescription, 'isBuiltin' | 'identifier' | 'main' | 'browser'>): boolean {
	return !extension.isBuiltin && !firstPartyCeiling(extension.identifier.value) && !!(extension.main || extension.browser);
}

/** The scan cache's version: a new rule set rescans everything. */
const SCAN_CACHE_VERSION = 2;

function cacheKey(extension: Pick<IExtensionDescription, 'identifier' | 'version'>): string {
	return `volt.codeScan.v${SCAN_CACHE_VERSION}.${extension.identifier.value.toLowerCase()}@${extension.version}`;
}

/** The scan's root path for {@link fileServiceScanReader}: paths below it are `/`-joined names, never parsed as URIs. */
const SCAN_ROOT = 'extension';

/** The file service as the scan's reader, under `root`: no symbolic links (they could point anywhere). */
export function fileServiceScanReader(fileService: IFileService, root: URI): ICodeScanReader {
	const resolve = (path: string) => {
		const relative = path === SCAN_ROOT ? [] : path.slice(SCAN_ROOT.length + 1).split('/');
		return relative.length ? joinPath(root, ...relative) : root;
	};
	return {
		list: async path => {
			const stat = await fileService.resolve(resolve(path), { resolveMetadata: true });
			return (stat.children ?? []).filter(child => !child.isSymbolicLink).map(child => ({ name: child.name, directory: child.isDirectory, size: child.size }));
		},
		read: async path => (await fileService.readFile(resolve(path))).value.toString(),
	};
}

export class VoltExtensionCodeScanService extends Disposable implements IVoltExtensionCodeScanService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidScan = this._register(new Emitter<{ readonly extension: IExtensionDescription; readonly result: ICodeScanResult }>());
	readonly onDidScan = this._onDidScan.event;
	private readonly scans = new Map<string, Promise<ICodeScanResult | undefined>>();
	/** One scan at a time: they read and lex whole bundles. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	scan(extension: IExtensionDescription): Promise<ICodeScanResult | undefined> {
		if (!isScannedExtension(extension)) {
			return Promise.resolve(undefined);
		}
		const key = cacheKey(extension);
		let pending = this.scans.get(key);
		if (!pending) {
			pending = this.cached(key) ?? this.run(extension, key);
			this.scans.set(key, pending);
			void pending.then(result => result && this._onDidScan.fire({ extension, result }));
		}
		return pending;
	}

	private cached(key: string): Promise<ICodeScanResult | undefined> | undefined {
		const raw = this.storageService.get(key, StorageScope.APPLICATION);
		if (!raw) {
			return undefined;
		}
		try {
			const result = JSON.parse(raw) as ICodeScanResult;
			return Array.isArray(result.findings) ? Promise.resolve(result) : undefined;
		} catch {
			return undefined;
		}
	}

	private run(extension: IExtensionDescription, key: string): Promise<ICodeScanResult | undefined> {
		const job = this.queue.then(async () => {
			const started = Date.now();
			try {
				const result = await scanExtensionFolder(SCAN_ROOT, fileServiceScanReader(this.fileService, extension.extensionLocation), codeScanOptionsOf(extension), () => timeout(0));
				this.storageService.store(key, JSON.stringify(result), StorageScope.APPLICATION, StorageTarget.MACHINE);
				this.logService.info(`[volt code scan] ${extension.identifier.value}@${extension.version}: ${result.files} files, ${Math.round(result.bytes / 1024)} KB in ${Date.now() - started} ms: ${result.findings.length ? result.findings.map(finding => `${finding.severity} ${finding.rule} ${finding.evidence}`).join('; ') : 'nothing found'}${result.skipped ? ` (${result.skipped} files not read)` : ''}`);
				return result;
			} catch (err) {
				this.logService.warn(`[volt code scan] ${extension.identifier.value}: ${err instanceof Error ? err.message : err}`);
				return undefined;
			}
		});
		this.queue = job;
		return job;
	}
}

registerSingleton(IVoltExtensionCodeScanService, VoltExtensionCodeScanService, InstantiationType.Delayed);

// --- what the user is told ---------------------------------------------------------------------------

const RULE_LABELS: Record<CodeScanRule, string> = {
	'invisible-code': localize('voltScan.invisible', "hides code in characters an editor doesn't show"),
	'hidden-name': localize('voltScan.hiddenName', "builds a sensitive name from pieces to hide it"),
	'encoded-payload': localize('voltScan.encoded', "decodes hidden text"),
	'raw-host': localize('voltScan.rawHost', "sends to an address it does not declare"),
	'undeclared-api': localize('voltScan.undeclaredApi', "calls Volt features it does not declare"),
	'credential-path': localize('voltScan.credential', "names a credential location"),
	'dynamic-code': localize('voltScan.dynamicCode', "runs code it builds at runtime"),
	'process-spawn': localize('voltScan.spawn', "starts other programs"),
	'computed-require': localize('voltScan.computedRequire', "loads modules by a computed name"),
	'env-harvest': localize('voltScan.env', "reads your whole environment"),
	'native-binding': localize('voltScan.native', "uses Node's internal bindings"),
};

/** "builds a sensitive name from pieces to hide it (eval, child_process)" */
export function describeFinding(rule: CodeScanRule, evidence: readonly string[]): string {
	return evidence.length ? `${RULE_LABELS[rule]} (${evidence.slice(0, 3).join(', ')}${evidence.length > 3 ? ', ...' : ''})` : RULE_LABELS[rule];
}

/** One line per rule, the high ones first: what the install sheet and the warning list. */
export function summarizeFindings(findings: readonly ICodeScanFinding[]): { readonly rule: CodeScanRule; readonly severity: ICodeScanFinding['severity']; readonly text: string; readonly where: string }[] {
	const byRule = new Map<CodeScanRule, ICodeScanFinding[]>();
	for (const finding of findings) {
		byRule.set(finding.rule, [...byRule.get(finding.rule) ?? [], finding]);
	}
	return [...byRule.entries()]
		.map(([rule, list]) => ({
			rule,
			severity: list.some(finding => finding.severity === 'high') ? 'high' as const : 'medium' as const,
			text: describeFinding(rule, [...new Set(list.map(finding => finding.evidence))]),
			where: `${list[0].file}:${list[0].line}`,
		}))
		.sort((a, b) => a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1);
}

/** The refusals worth telling the user about: a third party going beyond its manifest, or asking for what Volt never gives. */
export function isMisbehaviorDenial(denial: Pick<IWouldBeDenial, 'deniedBy'>): boolean {
	return denial.deniedBy === 'manifest' || denial.deniedBy === 'critical' || denial.deniedBy === 'catalog';
}

/** "automations.schedule, usage.report and 2 more" */
function capabilityList(denials: readonly IWouldBeDenial[]): string {
	const names = [...new Set(denials.map(denial => denial.capability === 'full' && denial.target ? denial.target : denial.capability))];
	const shown = names.slice(0, 3);
	return names.length > shown.length
		? localize('voltWatch.more', "{0} and {1} more", shown.join(', '), names.length - shown.length)
		: shown.join(', ');
}

export class VoltExtensionWatchContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltExtensionWatch';

	/** Refusals by extension id (lower case) not warned about yet, and all told since the warning opened. */
	private readonly refusals = new Map<string, IWouldBeDenial[]>();
	private readonly told = new Map<string, IWouldBeDenial[]>();
	private readonly refusalKeys = new Set<string>();
	private readonly open = new Map<string, INotificationHandle>();
	private readonly closeListeners = this._register(new DisposableMap<string>());
	private readonly flush = this._register(new RunOnceScheduler(() => this.warnRefusals(), 400));

	constructor(
		@IVoltExtensionApiService extensionApi: IVoltExtensionApiService,
		@IVoltExtensionSandboxService private readonly sandbox: IVoltExtensionSandboxService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(extensionApi.policy.onDidReport(denial => this.onRefusal(denial)));
	}

	private extension(id: string): IExtensionDescription | undefined {
		return this.extensionService.extensions.find(candidate => ExtensionIdentifier.equals(candidate.identifier, id));
	}

	// --- runtime ---

	private onRefusal(denial: IWouldBeDenial): void {
		if (!isMisbehaviorDenial(denial)) {
			return;
		}
		const extension = this.extension(denial.extensionId);
		if (!extension || !isScannedExtension(extension)) {
			return; // built-ins answer to their ceilings and CI
		}
		const id = extension.identifier.value.toLowerCase();
		const key = `${id}\u0000${denial.capability}\u0000${denial.target ?? ''}`;
		this.logService.warn(`[volt extension watch] refused ${extension.identifier.value} ${denial.api} ${denial.capability}${denial.target ? ` on ${denial.target}` : ''} (${denial.deniedBy}): ${denial.reason}`);
		if (this.refusalKeys.has(key)) {
			return;
		}
		this.refusalKeys.add(key);
		this.refusals.set(id, [...this.refusals.get(id) ?? [], denial]);
		this.flush.schedule();
	}

	private warnRefusals(): void {
		for (const [id, fresh] of this.refusals) {
			const extension = this.extension(id);
			if (!extension) {
				continue;
			}
			const denials = [...this.told.get(id) ?? [], ...fresh];
			this.told.set(id, denials);
			const name = extension.displayName ?? extension.name;
			const message = localize('voltWatch.refused', "Volt blocked {0}: it tried to use {1}, which it never declared or Volt never gives an extension.", name, capabilityList(denials));
			const existing = this.open.get(id);
			if (existing) {
				existing.updateMessage(message);
				continue;
			}
			const sandboxed = this.sandbox.isOptedIn(extension.identifier.value);
			const handle = this.notificationService.prompt(Severity.Warning, message, [
				{ label: localize('voltWatch.details', "Show Details"), run: () => void this.showRefusals(extension, this.told.get(id) ?? denials) },
				...(sandboxed ? [] : [{ label: localize('voltWatch.sandbox', "Run in a Sandbox"), run: () => void this.sandbox.setOptedIn(extension.identifier.value, true) }]),
				{ label: localize('voltWatch.open', "Show Extension"), run: () => void this.commandService.executeCommand('extension.open', extension.identifier.value) },
			], { sticky: true });
			this.open.set(id, handle);
			this.closeListeners.set(id, handle.onDidClose(() => {
				this.closeListeners.deleteAndDispose(id);
				this.open.delete(id);
				this.told.delete(id);
			}));
		}
		this.refusals.clear();
	}

	private async showRefusals(extension: IExtensionDescription, denials: readonly IWouldBeDenial[]): Promise<void> {
		await this.dialogService.info(
			localize('voltWatch.detailsTitle', "What Volt blocked {0} from doing", extension.displayName ?? extension.name),
			denials.map(denial => `${denial.api}: ${denial.capability}${denial.target ? ` (${denial.target})` : ''}. ${denial.reason}`).join('\n'),
		);
	}
}

registerWorkbenchContribution2(VoltExtensionWatchContribution.ID, VoltExtensionWatchContribution, WorkbenchPhase.Eventually);
