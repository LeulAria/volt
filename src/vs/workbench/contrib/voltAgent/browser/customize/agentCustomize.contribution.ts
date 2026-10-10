/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { AgentCustomizeService, IAgentCustomizeService } from './agentCustomizeService.js';
import { AgentMarketplaceService, IAgentMarketplaceService } from './agentMarketplace.js';
import './agentSkillEditor.contribution.js';

registerSingleton(IAgentCustomizeService, AgentCustomizeService, InstantiationType.Delayed);
registerSingleton(IAgentMarketplaceService, AgentMarketplaceService, InstantiationType.Delayed);
