/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService } from '../../../../platform/notification/common/notification.js';
import { isPluginSubject, SubjectKey, subjectExtensionId } from '../../../../platform/voltSandbox/common/principals.js';
import { ISandboxWorkloadDenial, ISandboxWorkloadInfo } from '../../../../platform/voltSandbox/common/sandboxWorkloads.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IVoltExtensionSandboxService } from '../../../services/extensions/common/voltExtensionSandbox.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../services/voltRuntime/common/runtime.js';
import { describeSandboxDenial, ISandboxWorkloadSource, sandboxWorkloadSources } from './sandboxWorkloadSources.js';

/** How often the agent server is asked while an extension runs sandboxed there (it pushes nothing to the desktop). */
const POLL_MS = 2_000;
/** At most this many refusals are named in one warning; the rest are counted. */
const NAMED = 3;

/** A host's refusals Volt has not warned about yet. */
export interface IFreshDenials {
	readonly workload: ISandboxWorkloadInfo;
	readonly denials: readonly ISandboxWorkloadDenial[];
}

/**
 * The refusals of extension and plugin hosts (`plugin:` subjects: third-party code) that `seen`
 * doesn't hold yet, by host; `seen` takes them. Keyed by subject, kind and target, so a restarted
 * host doesn't warn again about what it already tried. Chats are left out: their denials show in
 * the transcript, with Allow buttons.
 */
export function freshDenials(seen: Set<string>, workloads: readonly ISandboxWorkloadInfo[]): IFreshDenials[] {
	const fresh: IFreshDenials[] = [];
	for (const workload of workloads) {
		const subject = workload.subject as SubjectKey | undefined;
		if (!subject || !isPluginSubject(subject) || !workload.denials?.length) {
			continue;
		}
		const denials = workload.denials.filter(denial => {
			const key = `${subject}\u0000${denial.kind}\u0000${denial.target}`;
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
		if (denials.length) {
			fresh.push({ workload, denials });
		}
	}
	return fresh;
}

/** "it tried to read ~/.ssh/id_ed25519, connect to evil.example:443 and 2 more things". */
export function deniedSummary(denials: readonly Pick<ISandboxWorkloadDenial, 'kind' | 'target'>[]): string {
	const named = denials.slice(0, NAMED).map(describeSandboxDenial);
	const more = denials.length - named.length;
	if (more > 0) {
		return localize('voltDenial.summaryMore', "it tried to {0} and {1} more", named.join(', '), more);
	}
	if (named.length === 1) {
		return localize('voltDenial.summaryOne', "it tried to {0}", named[0]);
	}
	return localize('voltDenial.summaryList', "it tried to {0} and {1}", named.slice(0, -1).join(', '), named[named.length - 1]);
}

/**
 * The runtime half of the extension sandbox's promise (spec G.12, P8): when the sandbox refuses a
 * sandboxed extension (or a plugin host) something, the user hears about it while it happens, not
 * only on the Security page. One warning per extension, updated while it is open, naming what was
 * tried; it offers the Security page and stopping the extension's host.
 */
export class SandboxDenialNotifier extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltSandboxDenialNotifier';

	private readonly sources: readonly ISandboxWorkloadSource[];
	private readonly seen = new Set<string>();
	/** Open warnings by subject: later refusals are added to them. */
	private readonly open = new Map<string, INotificationHandle>();
	private readonly told = new Map<string, ISandboxWorkloadDenial[]>();
	private readonly scheduler = this._register(new RunOnceScheduler(() => void this.check(), 300));
	private poll: number | undefined;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IVoltExtensionSandboxService private readonly sandbox: IVoltExtensionSandboxService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.sources = instantiationService.invokeFunction(sandboxWorkloadSources);
		for (const source of this.sources) {
			if (source.onDidChange) {
				this._register(source.onDidChange(() => this.scheduler.schedule()));
			}
		}
		this._register(this.sandbox.onDidChange(() => this.updatePolling()));
		this._register(this.extensionService.onDidChangeExtensions(() => this.updatePolling()));
		this._register(toDisposable(() => {
			mainWindow.clearInterval(this.poll);
			for (const handle of [...this.open.values()]) {
				handle.close();
			}
		}));
		this.updatePolling();
	}

	/** Sources that push nothing are asked only while an extension runs sandboxed. */
	private updatePolling(): void {
		const sandboxed = this.extensionService.extensions.some(extension => this.sandbox.state(extension.identifier.value).kind === 'sandboxed');
		if (sandboxed && !this.poll && this.sources.some(source => !source.onDidChange)) {
			this.poll = mainWindow.setInterval(() => this.scheduler.schedule(), POLL_MS);
			this.scheduler.schedule();
		} else if (!sandboxed && this.poll) {
			mainWindow.clearInterval(this.poll);
			this.poll = undefined;
		}
	}

	private async check(): Promise<void> {
		for (const source of this.sources) {
			const rows = await source.load();
			for (const { workload, denials } of freshDenials(this.seen, rows)) {
				this.warn(source, workload, denials);
			}
		}
	}

	private warn(source: ISandboxWorkloadSource, workload: ISandboxWorkloadInfo, denials: readonly ISandboxWorkloadDenial[]): void {
		const subject = workload.subject!;
		const extensionId = subjectExtensionId(subject as SubjectKey);
		const extension = extensionId ? this.extensionService.extensions.find(candidate => ExtensionIdentifier.equals(candidate.identifier, extensionId)) : undefined;
		const name = extension?.displayName ?? extension?.name ?? extensionId ?? workload.label;
		const all = [...(this.told.get(subject) ?? []), ...denials];
		this.told.set(subject, all);
		this.logService.warn(`[volt-sandbox] ${extensionId ?? workload.label} was refused: ${denials.map(denial => `${denial.kind} ${denial.target}`).join(', ')}`);
		const message = localize('voltDenial.message', "Volt's sandbox blocked {0}: {1}.", name, deniedSummary(all));
		const existing = this.open.get(subject);
		if (existing) {
			existing.updateMessage(message);
			return;
		}
		const handle = this.notificationService.prompt(Severity.Warning, message, [
			{
				label: localize('voltDenial.show', "Show Details"),
				run: () => void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID, 'security'),
			},
			{
				label: localize('voltDenial.stop', "Stop {0}", name),
				run: () => void source.stop(workload.id),
			},
		], { sticky: true });
		this.open.set(subject, handle);
		const listener = handle.onDidClose(() => {
			listener.dispose();
			this.told.delete(subject);
			this.open.delete(subject);
		});
	}
}
