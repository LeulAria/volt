/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { BROWSER_SNAPSHOT_TOOL_NAME, CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID, IVoltHostToolInfo, IVoltHostToolResult, IVoltHostToolService, IVoltMcpServer, VOLT_HOST_TOOLS } from '../common/hostTools.js';

export class VoltHostToolService extends Disposable implements IVoltHostToolService {

	declare readonly _serviceBrand: undefined;

	private mcpUrl: string | undefined;
	private readonly _onDidChangeMcp = this._register(new Emitter<void>());
	readonly onDidChangeMcp: Event<void> = this._onDidChangeMcp.event;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
	}

	listTools(): readonly IVoltHostToolInfo[] {
		return VOLT_HOST_TOOLS;
	}

	async invokeTool(name: string, _input?: unknown): Promise<IVoltHostToolResult> {
		if (name === BROWSER_SNAPSHOT_TOOL_NAME) {
			return this.captureBrowser();
		}
		return { error: `Unknown tool ${name}` };
	}

	getMcpServers(): readonly IVoltMcpServer[] {
		if (!this.mcpUrl) {
			return [];
		}
		return [{ type: 'http', name: 'volt', url: this.mcpUrl }];
	}

	setMcpEndpoint(url: string | undefined): void {
		if (this.mcpUrl === url) {
			return;
		}
		this.mcpUrl = url;
		this._onDidChangeMcp.fire();
	}

	private async captureBrowser(): Promise<IVoltHostToolResult> {
		const image = await this.commandService.executeCommand(CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID) as string | undefined;
		if (!image) {
			return { error: 'No in-app browser page is available to capture.' };
		}
		return { text: 'Captured the in-app browser.', image };
	}
}

registerSingleton(IVoltHostToolService, VoltHostToolService, InstantiationType.Delayed);
