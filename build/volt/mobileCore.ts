/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the Volt mobile app shares with the web app and the agent window: the agent server client,
// the remote services, the send path, and the home list model. buildMobileCore.mjs bundles this
// (no DOM) into apps/mobile/src/core/voltCore.js; the app imports types from here.

export { AgentClientServices, agentTurnStatus, bindChatToProject, currentModelRef, formatWorkedDuration, homeSessions, sendAgentPrompt, stopAgentTurn } from '../../src/vs/workbench/services/voltAgentServer/common/agentClientServices.js';
export type { IAgentClientServicesOptions, IAgentClientStorage, IAgentClientSend } from '../../src/vs/workbench/services/voltAgentServer/common/agentClientServices.js';
export type { AgentServerConnectionState, IWebSocketLike } from '../../src/vs/platform/voltAgentServer/common/connection.js';
export type { IAgentSessionMeta } from '../../src/vs/workbench/services/voltRuntime/common/history/agentHistory.js';
export type { IVoltProjectRecord } from '../../src/vs/workbench/services/voltRuntime/common/sessionContext.js';
export type { IVoltCatalogItem } from '../../src/vs/workbench/services/voltRuntime/common/providers.js';
export { buildAgentHomeTree, compactSessionAge, sessionStatusBadge, agentHomeGroupLabel } from '../../src/vs/workbench/contrib/voltAgent/browser/home/agentHomeModel.js';
export type { AgentHomeElement, IAgentHomeNode, IAgentHomeStatusBadge, AgentHomeStatusBadgeKind } from '../../src/vs/workbench/contrib/voltAgent/browser/home/agentHomeModel.js';
export { defaultAgentHomeViewState, sessionFolders, statusBucketLabel } from '../../src/vs/workbench/contrib/voltAgent/browser/home/agentHomeFilter.js';
export { repoInitials } from '../../src/vs/workbench/contrib/voltAgent/browser/home/agentRepoInfo.js';
export type { IAgentRepoInfo } from '../../src/vs/workbench/contrib/voltAgent/browser/home/agentRepoInfo.js';
export { ACCESS_MODE_OPTIONS } from '../../src/vs/workbench/services/voltRuntime/common/access/accessModes.js';
export type { VoltAccessMode } from '../../src/vs/workbench/services/voltRuntime/common/access/accessModes.js';
export { splitModelDisplayName } from '../../src/vs/workbench/services/voltRuntime/common/models/modelOptions.js';
export { providerFamily } from '../../src/vs/workbench/services/voltRuntime/browser/providers/providerFamily.js';
export { VOLT_FONT_FAMILY } from '../../src/vs/workbench/contrib/voltAgent/common/agentTypography.js';
export type { EmbedCommand, EmbedEvent } from '../../src/vs/workbench/contrib/voltAgentWeb/common/embedProtocol.js';
export { PROVIDER_BRAND_DATA } from '../../src/vs/workbench/services/voltRuntime/browser/providers/providerBrandData.js';
export type { IProviderBrandData, IProviderBrandPath } from '../../src/vs/workbench/services/voltRuntime/browser/providers/providerBrandData.js';
export { THINKING_DOTS_SPEED, thinkingDotOpacities } from '../../src/vs/workbench/contrib/voltAgent/common/agentThinkingDotsModel.js';
export { limitRecoveryView, nextLimitViewChange } from '../../src/vs/workbench/services/voltRuntime/common/orchestration/limitRecovery.js';
export type { ILimitRecoveryView } from '../../src/vs/workbench/services/voltRuntime/common/orchestration/limitRecovery.js';
export type { IOrchLimitStop } from '../../src/vs/workbench/services/voltRuntime/common/orchestration/orchestrator.js';
