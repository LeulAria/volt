/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import type { IPlaygroundModel, IPlaygroundRequest } from '../../shared/api.js';
import { allowedModels, forwardAs } from '../gateway/index.js';
import type { IPrincipal } from '../gateway/principal.js';
import { audit } from '../lib/audit.js';
import { actor, type AppEnv, fail, readJson, requireOrg, requirePermission, requireSession } from '../lib/context.js';

/**
 * The gateway playground. An admin sends a prompt from the console through the gateway's own
 * path: their effective policy, rate limit, budgets, request inspection (tools, MCP, DLP), the
 * organization's key, streaming, metering and audit — what Volt gets, minus the device. The
 * console session stands in for a device-bound token, so the playground is limited to roles that
 * manage policy, output is capped, and every request is audited.
 */
export const playgroundApi = new Hono<AppEnv>();
playgroundApi.use('*', requireSession, requireOrg, requirePermission({ policy: ['update'] }));

const MAX_OUTPUT = 4096;
const CLIENT = 'Volt Govern playground';

function principalOf(c: Parameters<typeof actor>[0]): IPrincipal {
	return { organizationId: c.var.org.id, userId: c.var.user.id, deviceId: null, client: CLIENT };
}

playgroundApi.get('/models', async c => {
	const principal = principalOf(c);
	const [anthropic, openai] = await Promise.all([allowedModels(principal, 'anthropic'), allowedModels(principal, 'openai')]);
	const models: IPlaygroundModel[] = [
		...anthropic.map(m => ({ id: m.id, provider: m.provider, format: 'anthropic' as const })),
		...openai.map(m => ({ id: m.id, provider: m.provider, format: 'openai' as const })),
	];
	return c.json(models);
});

playgroundApi.post('/send', async c => {
	const input = await readJson<IPlaygroundRequest>(c);
	if (!input?.model || !input.messages?.length || (input.format !== 'anthropic' && input.format !== 'openai')) {
		return fail(c, 400, 'A model, a wire format and at least one message are required');
	}
	const messages = input.messages.slice(-40).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 100_000) }));
	const maxTokens = Math.min(MAX_OUTPUT, Math.max(1, Math.floor(input.maxTokens ?? 1024)));
	const system = input.system?.trim().slice(0, 20_000);
	const body: Record<string, unknown> = input.format === 'anthropic'
		? { model: input.model, max_tokens: maxTokens, stream: input.stream !== false, messages, ...(system ? { system } : {}) }
		: { model: input.model, max_completion_tokens: maxTokens, stream: input.stream !== false, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages] };
	await audit({ ...actor(c), action: 'gateway.playground', targetType: 'model', targetId: input.model, detail: { format: input.format, maxTokens } });
	return forwardAs(c, input.format, input.format === 'anthropic' ? 'messages' : 'chat', { principal: principalOf(c), body });
});
