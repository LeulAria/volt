/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltSecurity.css';
import { $, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { capabilityClass, VoltCapabilityClass, versionedCapability } from '../../../../platform/voltPlugins/common/capabilityCatalog.js';
import { firstPartyCeiling } from '../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { IUserGestureToken, SubjectKey } from '../../../../platform/voltSandbox/common/principals.js';
import { TrustGrantDraft } from '../../../../platform/voltSandbox/common/trust.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { isScannedExtension, IVoltExtensionCodeScanService, summarizeFindings } from '../../../services/extensions/browser/voltExtensionCodeScan.js';
import { IVoltExtensionSandboxService } from '../../../services/extensions/common/voltExtensionSandbox.js';
import { codeScanDigest } from '../../../../platform/voltPlugins/common/extensionCodeScan.js';
import { IVoltExtensionApiService } from '../../../services/voltPlugins/common/voltExtensionApi.js';
import { pickVoltContributes } from '../../../services/voltPlugins/common/voltContributions.js';
import { bindGestureButton } from '../../../services/voltTrust/browser/gestureTokens.js';
import { IVoltTrustService } from '../../../services/voltTrust/common/voltTrust.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { voltCapabilityCopy } from '../../voltCustomize/browser/voltExtensionConsent.js';
import { showVoltModal } from '../../voltProjects/browser/ui/voltModal.js';

/** One capability an extension declares, as the sheet lists it. */
export interface IInstallSheetCapability {
	readonly id: string;
	readonly class: VoltCapabilityClass;
	readonly required: boolean;
	readonly targets?: readonly string[];
	/** The extension's own words: shown as its claim. */
	readonly reason?: string;
}

export interface IInstallSheetGroup {
	readonly class: Exclude<VoltCapabilityClass, 'none'>;
	/** What Allow does for this class (G.4, G.8), in Volt's words. */
	readonly outcome: string;
	readonly capabilities: readonly IInstallSheetCapability[];
}

const CLASS_ORDER: readonly Exclude<VoltCapabilityClass, 'none'>[] = ['low', 'medium', 'high', 'critical'];

function outcomeOf(cls: Exclude<VoltCapabilityClass, 'none'>): string {
	switch (cls) {
		case 'low': return localize('voltSheet.low', "Allowed while the extension is enabled.");
		case 'medium': return localize('voltSheet.medium', "Allowed now if you choose Allow. You can revoke them in Settings, Access.");
		case 'high': return localize('voltSheet.high', "Not allowed now: Volt asks when the extension first uses them.");
		case 'critical': return localize('voltSheet.critical', "Never allowed: Volt does not give these to extensions.");
	}
}

/** An extension's declared Volt capabilities, by class (`none` left out: always allowed, nothing to say). */
export function installSheetGroups(extension: Pick<IExtensionDescription, 'contributes'>): IInstallSheetGroup[] {
	const declared = pickVoltContributes(extension.contributes).voltCapabilities;
	const entries: IInstallSheetCapability[] = [
		...(declared?.required ?? []).map(entry => ({ entry, required: true })),
		...(declared?.optional ?? []).map(entry => ({ entry, required: false })),
	].flatMap(({ entry, required }) => {
		const cls = capabilityClass(entry.id);
		return cls && cls !== 'none' ? [{ id: entry.id, class: cls, required, ...(entry.targets?.length ? { targets: entry.targets } : {}), ...(entry.reason ? { reason: entry.reason } : {}) }] : [];
	});
	return CLASS_ORDER.map(cls => ({ class: cls, outcome: outcomeOf(cls), capabilities: entries.filter(entry => entry.class === cls) })).filter(group => group.capabilities.length > 0);
}

/** What Allow records: a persistent user grant for each declared medium capability (G.4 install-time). */
export function installSheetDrafts(subject: SubjectKey, groups: readonly IInstallSheetGroup[], at: number): TrustGrantDraft[] {
	return groups.filter(group => group.class === 'medium').flatMap(group => group.capabilities).map(entry => ({
		id: `sheet:${subject}:${versionedCapability(entry.id)}:${at}`,
		subject,
		capability: versionedCapability(entry.id),
		scope: entry.targets?.length ? { targets: entry.targets } : {},
		kind: 'persistent' as const,
		source: 'user' as const,
		grantedAt: at,
		lastUsedAt: at,
	}));
}

/** The sheet is shown again only when what the extension declares changed (G.9 updates). */
export function installSheetKey(subject: SubjectKey, groups: readonly IInstallSheetGroup[]): string {
	const sha = new StringSHA1();
	sha.update(JSON.stringify(groups.map(group => [group.class, group.capabilities.map(entry => [entry.id, entry.required, entry.targets ?? []])])));
	return `volt.trust.installSheet.${subject}.${sha.digest().slice(0, 16)}`;
}

/** A line of the install-time code scan (`extensionCodeScan.ts`), as the sheet lists it. */
export interface IInstallSheetFinding {
	readonly severity: 'high' | 'medium';
	/** Volt's words: "builds a sensitive name from pieces to hide it (eval, child_process)". */
	readonly text: string;
	/** `out/extension.js:12`. */
	readonly where: string;
}

type SheetRow = { readonly kind: 'group'; readonly group: IInstallSheetGroup } | { readonly kind: 'capability'; readonly capability: IInstallSheetCapability }
	| { readonly kind: 'scan'; readonly sandboxed: boolean } | { readonly kind: 'finding'; readonly finding: IInstallSheetFinding };

const GROUP_HEIGHT = 40;
const CAPABILITY_HEIGHT = 46;

class SheetDelegate implements IListVirtualDelegate<SheetRow> {
	getHeight(row: SheetRow): number {
		return row.kind === 'group' || row.kind === 'scan' ? GROUP_HEIGHT : CAPABILITY_HEIGHT;
	}
	getTemplateId(row: SheetRow): string {
		return row.kind === 'group' || row.kind === 'scan' ? 'group' : 'capability';
	}
}

const CLASS_LABELS: Record<Exclude<VoltCapabilityClass, 'none'>, string> = {
	low: localize('voltSheet.class.low', "Low"),
	medium: localize('voltSheet.class.medium', "Medium"),
	high: localize('voltSheet.class.high', "High"),
	critical: localize('voltSheet.class.critical', "Critical"),
};

class GroupRenderer implements IListRenderer<SheetRow, { readonly title: HTMLElement; readonly outcome: HTMLElement }> {
	readonly templateId = 'group';
	renderTemplate(container: HTMLElement) {
		const row = append(container, $('.volt-install-sheet-group'));
		return { title: append(row, $('span.title')), outcome: append(row, $('span.outcome')) };
	}
	renderElement(row: SheetRow, _index: number, template: { readonly title: HTMLElement; readonly outcome: HTMLElement }): void {
		if (row.kind === 'group') {
			template.title.textContent = CLASS_LABELS[row.group.class];
			template.outcome.textContent = row.group.outcome;
		} else if (row.kind === 'scan') {
			template.title.textContent = localize('voltSheet.scan', "Found in its code");
			template.outcome.textContent = row.sandboxed
				? localize('voltSheet.scanSandboxed', "It runs in Volt's sandbox, which blocks what it is not allowed.")
				: localize('voltSheet.scanShared', "It runs with your access. Volt's sandbox would block what it is not allowed.");
		}
	}
	disposeTemplate(): void { }
}

class CapabilityRenderer implements IListRenderer<SheetRow, { readonly title: HTMLElement; readonly detail: HTMLElement }> {
	readonly templateId = 'capability';
	renderTemplate(container: HTMLElement) {
		const row = append(container, $('.volt-install-sheet-capability'));
		return { title: append(row, $('span.title')), detail: append(row, $('span.detail')) };
	}
	renderElement(row: SheetRow, _index: number, template: { readonly title: HTMLElement; readonly detail: HTMLElement }): void {
		template.title.parentElement!.classList.toggle('high', row.kind === 'finding' && row.finding.severity === 'high');
		if (row.kind === 'finding') {
			// A list line of its own: "Builds a sensitive name ..." (the text also runs inside sentences).
			template.title.textContent = row.finding.text.charAt(0).toUpperCase() + row.finding.text.slice(1);
			template.detail.textContent = row.finding.where;
			template.title.parentElement!.title = `${row.finding.text}\n${row.finding.where}`;
			return;
		}
		if (row.kind !== 'capability') {
			return;
		}
		const copy = voltCapabilityCopy(row.capability.id);
		const targets = row.capability.targets?.length ? ` (${row.capability.targets.join(', ')})` : '';
		template.title.textContent = `${copy.title}${targets}${row.capability.required ? '' : localize('voltSheet.optional', ", optional")}`;
		template.detail.textContent = row.capability.reason ? localize('voltSheet.claim', "{0} The extension says: \"{1}\"", copy.detail, row.capability.reason) : copy.detail;
	}
	disposeTemplate(): void { }
}

export interface IInstallSheetRequest {
	readonly extensionName: string;
	readonly publisher: string;
	readonly groups: readonly IInstallSheetGroup[];
	readonly gesture: { readonly registry: IVoltTrustService['gestures']; readonly principal: string };
	/** What the install-time code scan found, the high findings first. */
	readonly findings?: readonly IInstallSheetFinding[];
	/** Set while it runs with the user's access: the sheet offers "Run in a Sandbox". */
	readonly runInSandbox?: () => void;
}

/**
 * The install sheet (spec P4, G.4, G.12): the first activation of a third-party extension that
 * declares Volt capabilities (a `.vsix` or Open VSX install; built-ins never see one) lists them by
 * class, in Volt's words, and says what Allow does for each class. Allow is gesture-armed; closing
 * or Don't Allow records nothing, and the extension asks at first use instead.
 */
export function showInstallSheet(layoutService: ILayoutService, instantiationService: IInstantiationService, request: IInstallSheetRequest, answer: (allowed: boolean, gesture?: IUserGestureToken) => void): IDisposable {
	let answered = false;
	const decide = (allowed: boolean, gesture?: IUserGestureToken) => {
		if (!answered) {
			answered = true;
			answer(allowed, gesture);
		}
	};
	const rows: SheetRow[] = [
		...(request.findings?.length ? [{ kind: 'scan' as const, sandboxed: !request.runInSandbox }, ...request.findings.map(finding => ({ kind: 'finding' as const, finding }))] : []),
		...request.groups.flatMap(group => [{ kind: 'group' as const, group }, ...group.capabilities.map(capability => ({ kind: 'capability' as const, capability }))]),
	];
	const grantsSomething = request.groups.some(group => group.class === 'medium');
	return showVoltModal(layoutService, {
		title: localize('voltSheet.title', "Extension permissions"),
		width: 520,
		height: 480,
		headless: true,
		className: 'volt-extension-consent volt-install-sheet',
		onDidClose: () => decide(false),
		render: (body, close) => {
			const store = new DisposableStore();
			const content = append(body, $('.volt-extension-consent-content'));
			const head = append(content, $('.head'));
			append(head, $('.mark')).appendChild(renderIcon(Codicon.extensions));
			const titles = append(head, $('.titles'));
			append(titles, $('h2')).textContent = localize('voltSheet.ask', "{0} asks for these permissions", request.extensionName);
			append(titles, $('.meta')).textContent = localize('voltSheet.meta', "Extension by {0}", request.publisher);
			const host = append(content, $('.volt-install-sheet-list'));
			const height = rows.reduce((sum, row) => sum + (row.kind === 'group' || row.kind === 'scan' ? GROUP_HEIGHT : CAPABILITY_HEIGHT), 0);
			host.style.height = `${height}px`;
			const list = store.add(instantiationService.createInstance(WorkbenchList<SheetRow>, 'VoltInstallSheet', host, new SheetDelegate(), [new GroupRenderer(), new CapabilityRenderer()], {
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				alwaysConsumeMouseWheel: false,
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('voltSheet.aria', "Permissions the extension declares"),
					getAriaLabel: (row: SheetRow) => row.kind === 'group' ? `${CLASS_LABELS[row.group.class]}: ${row.group.outcome}`
						: row.kind === 'capability' ? voltCapabilityCopy(row.capability.id).title
							: row.kind === 'finding' ? `${row.finding.text}, ${row.finding.where}` : localize('voltSheet.scan', "Found in its code"),
				},
			}));
			list.layout(height);
			list.splice(0, 0, rows);

			const footer = append(body, $('.volt-add-footer'));
			append(footer, $('span.volt-add-footer-hint'));
			const runInSandbox = request.runInSandbox;
			if (runInSandbox) {
				const sandbox = store.add(createVoltButton(footer));
				sandbox.label = localize('voltSheet.runInSandbox', "Run in a Sandbox");
				sandbox.element.classList.add('sandbox');
				// Opts it in; the sheet stays for the permissions (the move happens at the next reload).
				store.add(sandbox.onDidClick(() => {
					runInSandbox();
					sandbox.label = localize('voltSheet.sandboxChosen', "Sandbox On After Reload");
					sandbox.enabled = false;
				}));
			}
			const deny = store.add(createVoltButton(footer));
			deny.label = localize('voltSheet.deny', "Don't Allow");
			deny.element.classList.add('deny');
			store.add(deny.onDidClick(() => {
				decide(false);
				close();
			}));
			if (grantsSomething) {
				const allow = store.add(createVoltButton(footer, 'primary'));
				allow.label = localize('voltSheet.allow', "Allow");
				allow.element.classList.add('allow');
				store.add(bindGestureButton(allow, request.gesture.registry, request.gesture.principal, token => {
					decide(true, token);
					close();
				}, { area: body }));
			} else {
				// Nothing here is granted by the sheet: it only says what the extension may ask for.
				deny.label = localize('voltSheet.ok', "OK");
			}
			deny.focus();
			return store;
		},
	});
}

/**
 * Shows the install sheet once per extension and declared set (G.9: a changed declaration asks
 * again), for third-party extensions that declare Volt capabilities, one sheet at a time.
 */
export class InstallSheetContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltInstallSheet';

	private queue: Promise<void> = Promise.resolve();
	private readonly shown = new Set<string>();
	/** Extensions (by declared set and version) already queued for a look. */
	private readonly considered = new Set<string>();

	constructor(
		@IExtensionService private readonly extensionService: IExtensionService,
		@IVoltTrustService private readonly trust: IVoltTrustService,
		@IVoltExtensionApiService private readonly extensionApi: IVoltExtensionApiService,
		@IStorageService private readonly storage: IStorageService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IVoltExtensionCodeScanService private readonly codeScan: IVoltExtensionCodeScanService,
		@IVoltExtensionSandboxService private readonly sandbox: IVoltExtensionSandboxService,
	) {
		super();
		const check = () => void this.trust.whenReady.then(() => this.check());
		this._register(extensionService.onDidChangeExtensions(check));
		void extensionService.whenInstalledExtensionsRegistered().then(check);
	}

	private check(): void {
		for (const extension of this.extensionService.extensions) {
			if (extension.isBuiltin || firstPartyCeiling(extension.identifier.value)) {
				continue; // Built-ins: zero prompts, capped by their ceilings (N.2).
			}
			const groups = installSheetGroups(extension);
			const scanned = isScannedExtension(extension);
			if (!groups.length && !scanned) {
				continue;
			}
			const subject = this.extensionApi.subjectOf?.(extension.identifier.value);
			if (!subject) {
				continue;
			}
			const considered = `${installSheetKey(subject, groups)}@${extension.version}`;
			if (this.considered.has(considered)) {
				continue;
			}
			this.considered.add(considered);
			this.queue = this.queue.then(async () => {
				// The code scan (once per version, cached): code that hides what it does gets the sheet
				// even when it declares no Volt capability, and again when an update adds such code.
				const scan = scanned ? await this.codeScan.scan(extension) : undefined;
				const high = scan?.findings.filter(finding => finding.severity === 'high') ?? [];
				if (!groups.length && !high.length) {
					return;
				}
				const key = installSheetKey(subject, groups) + (high.length ? `.${codeScanDigest(high)}` : '');
				if (this.shown.has(key) || this.storage.getBoolean(key, StorageScope.APPLICATION, false)) {
					return;
				}
				this.shown.add(key);
				return this.ask(extension, subject, groups, key, scan ? summarizeFindings(scan.findings) : []);
			});
		}
	}

	private ask(extension: IExtensionDescription, subject: SubjectKey, groups: readonly IInstallSheetGroup[], key: string, findings: readonly IInstallSheetFinding[]): Promise<void> {
		const id = extension.identifier.value;
		return new Promise<void>(resolve => {
			const sheet = this._register(new DisposableStore());
			sheet.add(showInstallSheet(this.layoutService, this.instantiationService, {
				extensionName: extension.displayName ?? extension.name,
				publisher: extension.publisher,
				groups,
				gesture: { registry: this.trust.gestures, principal: subject },
				...(findings.length ? { findings } : {}),
				...(findings.length && !this.sandbox.isOptedIn(id) ? { runInSandbox: () => void this.sandbox.setOptedIn(id, true) } : {}),
			}, (allowed, gesture) => {
				const done = () => {
					this._store.delete(sheet);
					resolve();
				};
				if (this._store.isDisposed) {
					return resolve(); // the window closed it, not the user
				}
				this.storage.store(key, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
				if (!allowed) {
					return done();
				}
				void this.trust.grant(subject, installSheetDrafts(subject, groups, Date.now()), gesture)
					.catch(err => this.logService.warn(`[volt install sheet] ${extension.identifier.value}: ${err instanceof Error ? err.message : err}`))
					.finally(done);
			}));
		});
	}
}
