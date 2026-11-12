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
import { IExtensionDescription, IExtensionManifest } from '../../../../platform/extensions/common/extensions.js';
import { extensionSandboxPlan } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { setVoltInstallReview } from '../../../services/extensionManagement/common/voltInstallReview.js';
import { IExtensionManifestPropertiesService } from '../../../services/extensions/common/extensionManifestPropertiesService.js';
import { IVoltExtensionSandboxService, voltPlatform } from '../../../services/extensions/common/voltExtensionSandbox.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { capabilityClass, VoltCapabilityClass, versionedCapability } from '../../../../platform/voltPlugins/common/capabilityCatalog.js';
import { isExfilHost } from '../../../../platform/voltSandbox/common/networkRules.js';
import { firstPartyCeiling } from '../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { IUserGestureToken, SubjectKey } from '../../../../platform/voltSandbox/common/principals.js';
import { TrustGrantDraft } from '../../../../platform/voltSandbox/common/trust.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IVoltExtensionApiService } from '../../../services/voltPlugins/common/voltExtensionApi.js';
import { pickVoltContributes } from '../../../services/voltPlugins/common/voltContributions.js';
import { bindGestureButton } from '../../../services/voltTrust/browser/gestureTokens.js';
import { IVoltTrustService } from '../../../services/voltTrust/common/voltTrust.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { voltCapabilityCopy } from '../../voltCustomize/browser/voltExtensionConsent.js';
import { showVoltModal } from '../../voltProjects/browser/ui/voltModal.js';
import { createVoltDropdown } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';

/** One capability an extension declares, as the sheet lists it. */
export interface IInstallSheetCapability {
	readonly id: string;
	readonly class: VoltCapabilityClass;
	readonly required: boolean;
	readonly targets?: readonly string[];
	/** The extension's own words: shown as its claim. */
	readonly reason?: string;
	/** `net.connect` to hosts that take data from anyone: high, whatever the catalog's class. */
	readonly exfil?: true;
}

export interface IInstallSheetGroup {
	readonly class: Exclude<VoltCapabilityClass, 'none'>;
	/** What Allow does for this class (G.4, G.8), in Volt's words. */
	readonly outcome: string;
	readonly capabilities: readonly IInstallSheetCapability[];
}

const CLASS_ORDER: readonly Exclude<VoltCapabilityClass, 'none'>[] = ['low', 'medium', 'high', 'critical'];

function outcomeOf(cls: Exclude<VoltCapabilityClass, 'none'>, atInstall: boolean): string {
	switch (cls) {
		case 'low': return localize('voltSheet.low', "Allowed while the extension is enabled.");
		case 'medium': return atInstall
			? localize('voltSheet.mediumInstall', "Not allowed now: Volt asks when the extension first uses them.")
			: localize('voltSheet.medium', "Allowed now if you choose Allow. You can revoke them in Settings, Access.");
		case 'high': return localize('voltSheet.high', "Not allowed now: Volt asks when the extension first uses them.");
		case 'critical': return localize('voltSheet.critical', "Never allowed: Volt does not give these to extensions.");
	}
}

/**
 * An extension's declared Volt capabilities, by class (`none` left out: always allowed, nothing to
 * say). `atInstall`: the review before installing, where Allow grants nothing yet.
 */
export function installSheetGroups(extension: Pick<IExtensionDescription, 'contributes'>, atInstall = false): IInstallSheetGroup[] {
	const declared = pickVoltContributes(extension.contributes).voltCapabilities;
	const entries: IInstallSheetCapability[] = [
		...(declared?.required ?? []).map(entry => ({ entry, required: true })),
		...(declared?.optional ?? []).map(entry => ({ entry, required: false })),
	].flatMap(({ entry, required }) => {
		const cls = capabilityClass(entry.id);
		if (!cls || cls === 'none') {
			return [];
		}
		const row = (rowClass: VoltCapabilityClass, targets: readonly string[] | undefined, exfil?: true): IInstallSheetCapability => ({ id: entry.id, class: rowClass, required, ...(targets?.length ? { targets } : {}), ...(entry.reason ? { reason: entry.reason } : {}), ...(exfil ? { exfil } : {}) });
		if (capabilityClass(entry.id) === 'low' && entry.id.split('@')[0] === 'net.connect' && entry.targets?.length) {
			// I.4 (as the broker judges it): a host that takes data from anyone (code hosts, paste and
			// file sites, object stores) is high, never an install-time grant. Say so here.
			const exfil = entry.targets.filter(target => isExfilHost(target.toLowerCase().replace(/:\d+$/, '')));
			const plain = entry.targets.filter(target => !exfil.includes(target));
			return [...(plain.length ? [row('low', plain)] : []), ...(exfil.length ? [row('high', exfil, true)] : [])];
		}
		return [row(cls, entry.targets)];
	});
	return CLASS_ORDER.map(cls => ({ class: cls, outcome: outcomeOf(cls, atInstall), capabilities: entries.filter(entry => entry.class === cls) })).filter(group => group.capabilities.length > 0);
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

/** The install review covered this declared set (the sheet at first activation is not shown for it). */
export function installReviewKey(extensionId: string, groups: readonly IInstallSheetGroup[]): string {
	const sha = new StringSHA1();
	sha.update(JSON.stringify(groups.map(group => [group.class, group.capabilities.map(entry => [entry.id, entry.required, entry.targets ?? []])])));
	return `volt.trust.installReview.${extensionId.toLowerCase()}.${sha.digest().slice(0, 16)}`;
}

/** The sheet is shown again only when what the extension declares changed (G.9 updates). */
export function installSheetKey(subject: SubjectKey, groups: readonly IInstallSheetGroup[]): string {
	const sha = new StringSHA1();
	sha.update(JSON.stringify(groups.map(group => [group.class, group.capabilities.map(entry => [entry.id, entry.required, entry.targets ?? []])])));
	return `volt.trust.installSheet.${subject}.${sha.digest().slice(0, 16)}`;
}

type SheetRow = { readonly kind: 'group'; readonly group: IInstallSheetGroup } | { readonly kind: 'capability'; readonly capability: IInstallSheetCapability };

const GROUP_HEIGHT = 40;
/** Two lines of detail: the extension's own reason must be readable, not cut off. */
const CAPABILITY_HEIGHT = 62;

class SheetDelegate implements IListVirtualDelegate<SheetRow> {
	getHeight(row: SheetRow): number {
		return row.kind === 'group' ? GROUP_HEIGHT : CAPABILITY_HEIGHT;
	}
	getTemplateId(row: SheetRow): string {
		return row.kind === 'group' ? 'group' : 'capability';
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
		if (row.kind !== 'capability') {
			return;
		}
		const copy = row.capability.exfil
			? { title: localize('voltSheet.exfilTitle', "Send data to hosts anyone can read"), detail: localize('voltSheet.exfilDetail', "These hosts take data from anyone (code hosts, paste and file sites). In a sandbox Volt refuses them to the extension's own code.") }
			: voltCapabilityCopy(row.capability.id);
		const targets = row.capability.targets?.length ? ` (${row.capability.targets.join(', ')})` : '';
		template.title.textContent = `${copy.title}${targets}${row.capability.required ? '' : localize('voltSheet.optional', ", optional")}`;
		template.detail.textContent = row.capability.reason ? localize('voltSheet.claim', "{0} The extension says: \"{1}\"", copy.detail, row.capability.reason) : copy.detail;
		// The id is what the extension's page and the Access page name it by.
		template.title.parentElement!.title = `${row.capability.id}\n${template.detail.textContent}`;
	}
	disposeTemplate(): void { }
}

export interface IInstallSheetRequest {
	readonly extensionName: string;
	readonly publisher: string;
	readonly groups: readonly IInstallSheetGroup[];
	readonly gesture: { readonly registry: IVoltTrustService['gestures']; readonly principal: string };
	/**
	 * The review before installing (H.10 step 3): the buttons are Cancel and Install, and when the
	 * extension has code the user picks where it runs, before any of it runs.
	 */
	readonly install?: {
		/** Its code: whether Volt can run it in a sandbox here, and why not. Absent: no code, nothing to choose. */
		readonly sandbox?: { readonly available: true } | { readonly available: false; readonly reason: string };
	};
}

export type InstallSheetPlace = 'sandbox' | 'full';

/**
 * The install sheet (spec P4, G.4, G.12): the first activation of a third-party extension that
 * declares Volt capabilities (a `.vsix` or Open VSX install; built-ins never see one) lists them by
 * class, in Volt's words, and says what Allow does for each class. Allow is gesture-armed; closing
 * or Don't Allow records nothing, and the extension asks at first use instead.
 */
export function showInstallSheet(layoutService: ILayoutService, instantiationService: IInstantiationService, request: IInstallSheetRequest, answer: (allowed: boolean, gesture?: IUserGestureToken, place?: InstallSheetPlace) => void): IDisposable {
	let answered = false;
	// Recommended, and what Install keeps unless the user picks otherwise.
	let place: InstallSheetPlace = request.install?.sandbox?.available ? 'sandbox' : 'full';
	const decide = (allowed: boolean, gesture?: IUserGestureToken) => {
		if (!answered) {
			answered = true;
			answer(allowed, gesture, request.install?.sandbox ? place : undefined);
		}
	};
	const rows: SheetRow[] = request.groups.flatMap(group => [{ kind: 'group' as const, group }, ...group.capabilities.map(capability => ({ kind: 'capability' as const, capability }))]);
	const grantsSomething = !request.install && request.groups.some(group => group.class === 'medium');
	return showVoltModal(layoutService, {
		title: request.install ? localize('voltSheet.installTitle', "Install extension") : localize('voltSheet.title', "Extension permissions"),
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
			append(titles, $('h2')).textContent = request.install
				? localize('voltSheet.installAsk', "Install {0}?", request.extensionName)
				: localize('voltSheet.ask', "{0} asks for these permissions", request.extensionName);
			append(titles, $('.meta')).textContent = localize('voltSheet.meta', "Extension by {0}", request.publisher);
			const sandbox = request.install?.sandbox;
			if (sandbox) {
				const where = append(content, $('.volt-install-sheet-where'));
				append(where, $('.title')).textContent = localize('voltSheet.where', "Where its code runs");
				const hint = append(where, $('.detail'));
				if (sandbox.available) {
					const describe = (value: InstallSheetPlace) => value === 'sandbox'
						? localize('voltSheet.sandboxHint', "It reads its own folder and this project, writes only its own storage, and reaches only the hosts it names. Volt tells you when it tries more.")
						: localize('voltSheet.fullHint', "Like any other extension: it can read and change your files, use the network and read your credentials.");
					const dropdown = createVoltDropdown<InstallSheetPlace>(where, instantiationService.invokeFunction(accessor => accessor.get(IContextViewService)), {
						options: [
							{ id: 'sandbox', label: localize('voltSheet.inSandbox', "In a sandbox (recommended)"), icon: Codicon.lock },
							{ id: 'full', label: localize('voltSheet.withAccess', "With your access"), icon: Codicon.unlock },
						],
						value: place,
						ariaLabel: localize('voltSheet.whereAria', "Where the extension's code runs"),
						onChange: value => {
							place = value;
							hint.textContent = describe(value);
						},
					}, store);
					dropdown.element.classList.add('volt-install-sheet-place');
					where.appendChild(hint); // under the choice it describes
					hint.textContent = describe(place);
				} else {
					hint.textContent = localize('voltSheet.noSandbox', "With your access: {0}", sandbox.reason);
				}
			}
			const host = append(content, $('.volt-install-sheet-list'));
			const height = rows.reduce((sum, row) => sum + (row.kind === 'group' ? GROUP_HEIGHT : CAPABILITY_HEIGHT), 0);
			host.style.height = `${height}px`;
			const list = store.add(instantiationService.createInstance(WorkbenchList<SheetRow>, 'VoltInstallSheet', host, new SheetDelegate(), [new GroupRenderer(), new CapabilityRenderer()], {
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				alwaysConsumeMouseWheel: false,
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('voltSheet.aria', "Permissions the extension declares"),
					getAriaLabel: (row: SheetRow) => row.kind === 'group' ? `${CLASS_LABELS[row.group.class]}: ${row.group.outcome}` : voltCapabilityCopy(row.capability.id).title,
				},
			}));
			list.layout(height);
			list.splice(0, 0, rows);

			const footer = append(body, $('.volt-add-footer'));
			append(footer, $('span.volt-add-footer-hint'));
			const deny = store.add(createVoltButton(footer));
			deny.label = request.install ? localize('voltSheet.cancel', "Cancel") : localize('voltSheet.deny', "Don't Allow");
			deny.element.classList.add('deny');
			store.add(deny.onDidClick(() => {
				decide(false);
				close();
			}));
			if (request.install) {
				// Installing is the user's own act from Volt's UI; the sheet grants nothing, so no gesture token.
				const install = store.add(createVoltButton(footer, 'primary'));
				install.label = localize('voltSheet.install', "Install");
				install.element.classList.add('allow');
				store.add(install.onDidClick(() => {
					decide(true);
					close();
				}));
			} else if (grantsSomething) {
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

	constructor(
		@IExtensionService private readonly extensionService: IExtensionService,
		@IVoltTrustService private readonly trust: IVoltTrustService,
		@IVoltExtensionApiService private readonly extensionApi: IVoltExtensionApiService,
		@IStorageService private readonly storage: IStorageService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IVoltExtensionSandboxService private readonly sandbox: IVoltExtensionSandboxService,
		@IExtensionManifestPropertiesService private readonly manifestProperties: IExtensionManifestPropertiesService,
	) {
		super();
		this._register(setVoltInstallReview({ review: manifest => this.reviewInstall(manifest) }));
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
			if (!groups.length) {
				continue;
			}
			const subject = this.extensionApi.subjectOf?.(extension.identifier.value);
			if (!subject) {
				continue;
			}
			const key = installSheetKey(subject, groups);
			// Reviewed before it was installed: medium capabilities are asked at first use instead.
			if (this.shown.has(key) || this.storage.getBoolean(key, StorageScope.APPLICATION, false) || this.storage.getBoolean(installReviewKey(extension.identifier.value, groups), StorageScope.APPLICATION, false)) {
				continue;
			}
			this.shown.add(key);
			this.queue = this.queue.then(() => this.ask(extension, subject, groups, key));
		}
	}

	/**
	 * Before an install from Volt's UI: what it declares and, when it has code, where that code runs,
	 * chosen before any of it runs (P4, H.10). The choice of a sandbox opts it in (N.1 #22: opt-in
	 * per extension, made here); "With your access" leaves it in the shared host as before.
	 */
	private async reviewInstall(manifest: IExtensionManifest): Promise<boolean> {
		if (!manifest.publisher || !manifest.name) {
			return true;
		}
		const id = `${manifest.publisher}.${manifest.name}`;
		const groups = installSheetGroups(manifest, true);
		const code = !!manifest.main || !!manifest.browser;
		// Already chosen (an update, a reinstall, `required` mode): nothing to choose again.
		const decided = this.sandbox.isOptedIn(id) || this.sandbox.state(id).kind === 'unsandboxed';
		if (!groups.length && (!code || decided)) {
			return true;
		}
		const plan = extensionSandboxPlan({ id, builtin: false, main: !!manifest.main, browser: !!manifest.browser, extensionKind: this.manifestProperties.getExtensionKind(manifest) }, voltPlatform());
		const sandbox = code && !decided
			? plan.kind === 'sandbox' ? { available: true as const } : plan.kind === 'refuse' ? { available: false as const, reason: plan.reason } : undefined
			: undefined;
		const answer = await new Promise<{ install: boolean; place?: InstallSheetPlace }>(resolve => {
			const sheet = this._register(new DisposableStore());
			sheet.add(showInstallSheet(this.layoutService, this.instantiationService, {
				extensionName: manifest.displayName ?? manifest.name,
				publisher: manifest.publisher,
				groups,
				gesture: { registry: this.trust.gestures, principal: id },
				install: { ...(sandbox ? { sandbox } : {}) },
			}, (install, _gesture, place) => {
				this._store.delete(sheet);
				resolve({ install, place });
			}));
		});
		if (!answer.install) {
			this.logService.info(`[volt install review] ${id}: the user cancelled the install`);
			return false;
		}
		if (answer.place === 'sandbox') {
			await this.sandbox.setOptedIn(id, true, { beforeInstall: true });
		}
		this.storage.store(installReviewKey(id, groups), true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.logService.info(`[volt install review] ${id}: install, code runs ${answer.place === 'sandbox' ? 'in a sandbox' : answer.place === 'full' ? 'with the user\'s access' : 'as before (nothing to choose)'}`);
		return true;
	}

	private ask(extension: IExtensionDescription, subject: SubjectKey, groups: readonly IInstallSheetGroup[], key: string): Promise<void> {
		return new Promise<void>(resolve => {
			const sheet = this._register(new DisposableStore());
			sheet.add(showInstallSheet(this.layoutService, this.instantiationService, {
				extensionName: extension.displayName ?? extension.name,
				publisher: extension.publisher,
				groups,
				gesture: { registry: this.trust.gestures, principal: subject },
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
