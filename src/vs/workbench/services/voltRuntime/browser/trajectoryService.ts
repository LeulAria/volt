/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { closeOpenToolRuns, ITrajectoryRequest, ITrajectoryRequestInput, newTrajectoryRequest } from '../common/harness/trajectory.js';
import { IVoltTrajectoryChat, IVoltTrajectoryService, VOLT_TRAJECTORY_ENABLED_SETTING } from '../common/trajectory.js';

/** Requests kept per chat; the oldest go first. */
const MAX_REQUESTS = 300;
/** Chats kept; the least recently updated go first. */
const MAX_CHATS = 24;
const CHANGE_DELAY_MS = 150;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.agent.trajectory',
	title: localize('voltTrajectory.configTitle', "Trajectory"),
	type: 'object',
	properties: {
		[VOLT_TRAJECTORY_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltTrajectory.enabled', "Records every model request of the agents Volt runs itself (prompt, tools, response, usage, timings) in memory, for the Trajectory panel. Nothing is saved to disk or sent anywhere."),
		},
	},
});

interface IChat {
	readonly sessionId: string;
	label?: string;
	updatedAt: number;
	next: number;
	requests: ITrajectoryRequest[];
}

export class VoltTrajectoryService extends Disposable implements IVoltTrajectoryService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	private readonly chatsById = new Map<string, IChat>();
	private readonly pending = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(@IConfigurationService private readonly configurationService: IConfigurationService) {
		super();
		this._register(toDisposable(() => {
			if (this.timer !== undefined) {
				clearTimeout(this.timer);
			}
		}));
	}

	get enabled(): boolean {
		return this.configurationService.getValue<boolean>(VOLT_TRAJECTORY_ENABLED_SETTING) !== false;
	}

	begin(input: Omit<ITrajectoryRequestInput, 'id' | 'index'>): ITrajectoryRequest | undefined {
		if (!this.enabled) {
			return undefined;
		}
		const chat = this.chat(input.sessionId);
		const previous = chat.requests.filter(candidate => candidate.agent === input.agent).at(-1);
		if (previous) {
			closeOpenToolRuns(previous);
		}
		const request = newTrajectoryRequest({ ...input, id: generateUuid(), index: ++chat.next });
		chat.requests.push(request);
		if (chat.requests.length > MAX_REQUESTS) {
			chat.requests.splice(0, chat.requests.length - MAX_REQUESTS);
		}
		this.changed(input.sessionId);
		return request;
	}

	latest(sessionId: string, runId: string): ITrajectoryRequest | undefined {
		const requests = this.chatsById.get(sessionId)?.requests;
		for (let i = (requests?.length ?? 0) - 1; i >= 0; i--) {
			if (requests![i].runId === runId) {
				return requests![i];
			}
		}
		return undefined;
	}

	changed(sessionId: string): void {
		const chat = this.chatsById.get(sessionId);
		if (!chat) {
			return;
		}
		chat.updatedAt = Date.now();
		this.pending.add(sessionId);
		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			const ids = [...this.pending];
			this.pending.clear();
			for (const id of ids) {
				this._onDidChange.fire(id);
			}
		}, CHANGE_DELAY_MS);
	}

	requests(sessionId: string): readonly ITrajectoryRequest[] {
		return this.chatsById.get(sessionId)?.requests ?? [];
	}

	chats(): readonly IVoltTrajectoryChat[] {
		return [...this.chatsById.values()]
			.filter(chat => chat.requests.length)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map(chat => ({ sessionId: chat.sessionId, ...(chat.label ? { label: chat.label } : {}), updatedAt: chat.updatedAt, requests: chat.requests.length }));
	}

	setLabel(sessionId: string, label: string): void {
		const chat = this.chatsById.get(sessionId);
		if (chat && label && chat.label !== label) {
			chat.label = label;
			this.changed(sessionId);
		}
	}

	clear(sessionId: string): void {
		const chat = this.chatsById.get(sessionId);
		if (chat) {
			chat.requests = [];
			this._onDidChange.fire(sessionId);
		}
	}

	private chat(sessionId: string): IChat {
		let chat = this.chatsById.get(sessionId);
		if (!chat) {
			chat = { sessionId, updatedAt: Date.now(), next: 0, requests: [] };
			this.chatsById.set(sessionId, chat);
			if (this.chatsById.size > MAX_CHATS) {
				const oldest = [...this.chatsById.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
				this.chatsById.delete(oldest.sessionId);
			}
		}
		return chat;
	}
}

registerSingleton(IVoltTrajectoryService, VoltTrajectoryService, InstantiationType.Delayed);
