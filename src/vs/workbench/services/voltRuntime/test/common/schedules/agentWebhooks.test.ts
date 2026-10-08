/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	describeWebhookDelivery, evaluateWebhookFilters, formatWebhookFilter, IAgentWebhookDelivery, isHandledDelivery, mergeWebhookDeliveries, parseWebhookDelivery, parseWebhookFilter,
	newWebhookTrigger, parseWebhookTrigger, planWebhookDelivery, recordWebhookDelivery, renderWebhookTemplate, resolveWebhookPath, splitWebhookPath, WEBHOOK_DELIVERIES_KEPT, webhookContext, webhookRunPrompt, truncateLines,
} from '../../../common/schedules/agentWebhooks.js';

const PR = {
	action: 'opened',
	number: 12,
	pull_request: { number: 12, title: 'Fix login', base: { ref: 'main' }, labels: [{ name: 'bug' }, { name: 'ui' }] },
	repository: { full_name: 'octo/app' },
	'odd.key': 'dotted',
};

function prContext(extra: Partial<Parameters<typeof webhookContext>[0]> = {}) {
	return webhookContext({ body: JSON.stringify(PR), headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request' }, query: { env: 'prod' }, id: 'dlv_1', receivedAt: Date.UTC(2026, 9, 8, 12), source: 'relay', ...extra });
}

suite('Volt webhook triggers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('context: JSON, form-encoded GitHub payloads, event from headers or body', () => {
		const context = prContext();
		assert.strictEqual(context.event, 'pull_request');
		assert.strictEqual((context.payload as typeof PR).number, 12);
		const form = webhookContext({ body: `payload=${encodeURIComponent(JSON.stringify({ action: 'closed' }))}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, id: 'x', receivedAt: 0, source: 'local' });
		assert.deepStrictEqual(form.payload, { action: 'closed' });
		const typed = webhookContext({ body: '{"type":"deploy.finished"}', id: 'x', receivedAt: 0, source: 'local' });
		assert.strictEqual(typed.event, 'deploy.finished');
		const plain = webhookContext({ body: 'hello', id: 'x', receivedAt: 0, source: 'local' });
		assert.strictEqual(plain.payload, 'hello');
	});

	test('paths: dots, indexes, quoted keys, $ and bare roots', () => {
		const context = prContext();
		assert.deepStrictEqual(splitWebhookPath('payload.labels[0]["a.b"]'), ['payload', 'labels', '0', 'a.b']);
		assert.strictEqual(resolveWebhookPath(context, 'payload.pull_request.labels[1].name'), 'ui');
		assert.strictEqual(resolveWebhookPath(context, '$.pull_request.base.ref'), 'main');
		assert.strictEqual(resolveWebhookPath(context, 'payload["odd.key"]'), 'dotted');
		assert.strictEqual(resolveWebhookPath(context, 'action'), 'opened');
		assert.strictEqual(resolveWebhookPath(context, 'headers.x-github-event'), 'pull_request');
		assert.strictEqual(resolveWebhookPath(context, 'query.env'), 'prod');
		assert.strictEqual(resolveWebhookPath(context, 'event'), 'pull_request');
		assert.strictEqual(resolveWebhookPath(context, 'payload.nope.deeper'), undefined);
		assert.strictEqual(resolveWebhookPath(context, 'payload.constructor'), undefined);
	});

	test('filters: every one must hold, with a reason when one does not', () => {
		const context = prContext();
		assert.deepStrictEqual(evaluateWebhookFilters([], context), { pass: true });
		assert.ok(evaluateWebhookFilters([{ path: 'event', op: 'equals', value: 'pull_request' }, { path: 'payload.action', op: 'in', value: 'opened, reopened' }], context).pass);
		assert.ok(evaluateWebhookFilters([{ path: 'payload.pull_request.title', op: 'matches', value: '^Fix' }], context).pass);
		assert.ok(evaluateWebhookFilters([{ path: 'payload.pull_request.title', op: 'contains', value: 'log' }], context).pass);
		assert.ok(evaluateWebhookFilters([{ path: 'payload.draft', op: 'not_equals', value: 'true' }], context).pass);
		const miss = evaluateWebhookFilters([{ path: 'event', op: 'equals', value: 'push' }], context);
		assert.strictEqual(miss.pass, false);
		assert.strictEqual(miss.reason, 'event is "pull_request", not "push"');
		assert.strictEqual(evaluateWebhookFilters([{ path: 'payload.merged', op: 'exists' }], context).reason, 'payload.merged is missing');
		// A broken regex never matches (and never throws).
		assert.strictEqual(evaluateWebhookFilters([{ path: 'event', op: 'matches', value: '(' }], context).pass, false);
		// Arrays match when any item does.
		const labels = webhookContext({ body: JSON.stringify({ labels: ['bug', 'ui'] }), id: 'x', receivedAt: 0, source: 'local' });
		assert.ok(evaluateWebhookFilters([{ path: 'labels', op: 'equals', value: 'ui' }], labels).pass);
	});

	test('filters typed as one line round-trip', () => {
		assert.deepStrictEqual(parseWebhookFilter('event = pull_request'), { path: 'event', op: 'equals', value: 'pull_request' });
		assert.deepStrictEqual(parseWebhookFilter('payload.action in opened,reopened'), { path: 'payload.action', op: 'in', value: 'opened,reopened' });
		assert.deepStrictEqual(parseWebhookFilter('payload.ref != "refs/heads/main"'), { path: 'payload.ref', op: 'not_equals', value: 'refs/heads/main' });
		assert.deepStrictEqual(parseWebhookFilter('payload.merged exists'), { path: 'payload.merged', op: 'exists' });
		assert.strictEqual(parseWebhookFilter('nonsense'), undefined);
		assert.strictEqual(formatWebhookFilter({ path: 'event', op: 'equals', value: 'push' }), 'event = push');
	});

	test('templates fill placeholders, fall back, and report missing ones', () => {
		const context = prContext();
		const rendered = renderWebhookTemplate('Review #{{payload.number}} "{{ payload.pull_request.title }}" on {{event}} ({{payload.milestone.title | "no milestone"}}){{payload.nope}}', context);
		assert.strictEqual(rendered.text, 'Review #12 "Fix login" on pull_request (no milestone)');
		assert.deepStrictEqual(rendered.missing, ['payload.milestone.title', 'payload.nope']);
		assert.match(renderWebhookTemplate('{{payload.pull_request.base}}', context).text, /"ref": "main"/);
	});

	test('run prompt: a long payload is cut at a line boundary, keeping every line whole', () => {
		const big = { items: Array.from({ length: 800 }, (_, index) => ({ index, title: `item ${index}` })) };
		const context = webhookContext({ body: JSON.stringify(big), headers: { 'content-type': 'application/json' }, id: 'dlv_big', receivedAt: 0, source: 'local' });
		const prompt = webhookRunPrompt({ title: 'Big', prompt: 'Summarize' }, context).text;
		const body = /<webhook_payload[^>]*>\n([\s\S]*)\n<\/webhook_payload>/.exec(prompt)![1];
		const kept = body.split('\n').filter(line => !line.startsWith('…'));
		assert.ok(body.includes('… ('), 'says what was dropped');
		assert.ok(kept.every(line => /^\s*[\[\]{}"0-9a-z:,]/i.test(line) || line === ''), 'every kept line is whole');
		assert.strictEqual(kept[0], '{');
		assert.ok(body.length < 12_500);
	});

	test('truncateLines: short text is untouched, a cut keeps whole lines and counts the rest', () => {
		assert.strictEqual(truncateLines('a\nb', 10), 'a\nb');
		assert.strictEqual(truncateLines('aaaa\nbbbb\ncccc', 10), 'aaaa\nbbbb\n… (1 more line not shown; the payload was longer than 10 characters)');
	});

	test('run prompt: header, rendered template, payload appended only without placeholders', () => {
		const context = prContext();
		const templated = webhookRunPrompt({ title: 'PR review', prompt: 'Review {{payload.pull_request.title}}' }, context);
		assert.match(templated.text, /^\[Volt\] Webhook task "PR review" received pull_request · opened · #12 Fix login · octo\/app \(delivery dlv_1\) at 2026-10-08T12:00:00.000Z/);
		assert.match(templated.text, /Review Fix login$/);
		assert.strictEqual(templated.display, 'Review Fix login');
		const plain = webhookRunPrompt({ title: 'Any', prompt: 'Handle this.' }, context);
		assert.match(plain.text, /<webhook_payload event="pull_request">\n\{\n {2}"action": "opened"/);
		assert.match(webhookRunPrompt({ title: 'Again', prompt: 'x' }, prContext({ redeliveryOf: 'dlv_0' })).text, /sent again/);
	});

	test('describes common deliveries', () => {
		assert.strictEqual(describeWebhookDelivery(prContext()), 'opened · #12 Fix login · octo/app');
		const push = webhookContext({ body: JSON.stringify({ ref: 'refs/heads/main', head_commit: { message: 'Bump\n\nbody' } }), id: 'x', receivedAt: 0, source: 'local' });
		assert.strictEqual(describeWebhookDelivery(push), 'Bump');
		assert.strictEqual(describeWebhookDelivery(webhookContext({ body: JSON.stringify({ ref: 'refs/heads/dev' }), id: 'x', receivedAt: 0, source: 'local' })), 'dev');
	});

	test('deliveries: merge relay and local views, keep the newest, know what was handled', () => {
		const base: IAgentWebhookDelivery = { id: 'a', taskId: 't', source: 'relay', receivedAt: 1, status: 'ran', threadId: 'agent-1' };
		const relayView: IAgentWebhookDelivery[] = [{ ...base, status: 'ran', threadId: undefined }, { id: 'b', taskId: 't', source: 'relay', receivedAt: 2, status: 'held' }];
		const merged = mergeWebhookDeliveries([base], relayView);
		assert.deepStrictEqual(merged.map(entry => [entry.id, entry.status, entry.threadId]), [['b', 'held', undefined], ['a', 'ran', 'agent-1']]);
		// A local "held" record follows the relay's later state.
		assert.strictEqual(mergeWebhookDeliveries([{ ...base, status: 'held' }], [{ ...base, status: 'expired' }])[0].status, 'expired');
		let list: IAgentWebhookDelivery[] = [];
		for (let i = 0; i < WEBHOOK_DELIVERIES_KEPT + 5; i++) {
			list = recordWebhookDelivery(list, { ...base, id: `d${i}`, receivedAt: i });
		}
		assert.strictEqual(list.length, WEBHOOK_DELIVERIES_KEPT);
		assert.strictEqual(list[0].id, 'd5');
		assert.ok(isHandledDelivery({ ...base, status: 'filtered' }));
		assert.ok(!isHandledDelivery({ ...base, status: 'failed' }));
		assert.ok(!isHandledDelivery(undefined));
	});

	test('persistence parses defensively', () => {
		assert.strictEqual(parseWebhookTrigger({ id: 'hk' }), undefined);
		assert.deepStrictEqual(parseWebhookTrigger({ id: 'hk', localToken: 't', signature: { kind: 'weird', secret: 's' }, filters: [{ path: 'event', op: 'equals', value: 'x' }, { path: 'a', op: 'bogus' }] }), {
			id: 'hk', localToken: 't', signature: { kind: 'none', secret: 's' }, filters: [{ path: 'event', op: 'equals', value: 'x' }],
		});
		assert.strictEqual(parseWebhookDelivery({ id: 'a', taskId: 't', receivedAt: 1, status: 'unknown' }), undefined);
		assert.deepStrictEqual(parseWebhookDelivery({ id: 'a', taskId: 't', receivedAt: 1, status: 'ran', source: 'local', threadId: 'x', payload: { body: '{}' } }), {
			id: 'a', taskId: 't', receivedAt: 1, status: 'ran', source: 'local', threadId: 'x', payload: { body: '{}', headers: {}, query: {} },
		});
	});
});

suite('Volt webhook delivery plans', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const hook = { ...newWebhookTrigger('hook_pr', 'local'), filters: [{ path: 'payload.action', op: 'equals' as const, value: 'opened' }] };
	const task = { title: 'Review PRs', prompt: 'Review #{{payload.number}}', enabled: true, webhook: hook, runs: [] };
	const delivery = (id: string, body: string, extra: { event?: string; redeliveryOf?: string } = {}) => webhookContext({ id, body, receivedAt: 1, source: 'relay', ...extra });

	test('a delivery to a task that is gone is unknown', () => {
		assert.deepStrictEqual(planWebhookDelivery(undefined, delivery('dlv_1', '{}')), { kind: 'unknown' });
		assert.deepStrictEqual(planWebhookDelivery({ ...task, webhook: undefined }, delivery('dlv_1', '{}')), { kind: 'unknown' });
	});

	test('a turned-off task does not run', () => {
		assert.deepStrictEqual(planWebhookDelivery({ ...task, enabled: false }, delivery('dlv_1', '{"action":"opened","number":3}')), { kind: 'off' });
	});

	test('a filtered delivery is recorded with the reason and does not run', () => {
		const plan = planWebhookDelivery(task, delivery('dlv_2', '{"action":"closed","number":3}'));
		assert.strictEqual(plan.kind, 'filtered');
	});

	test('a delivery that already ran answers with its thread, never a second run', () => {
		const ran = { ...task, runs: [{ threadId: 'chat-9', webhook: { deliveryId: 'dlv_3' } }] };
		assert.deepStrictEqual(planWebhookDelivery(ran, delivery('dlv_3', '{"action":"opened","number":3}')), { kind: 'duplicate', threadId: 'chat-9' });
		assert.deepStrictEqual(planWebhookDelivery(ran, delivery('dlv_4', '{"action":"opened","number":3}')).kind, 'run');
	});

	test('a matching delivery renders the prompt template with the payload', () => {
		const plan = planWebhookDelivery(task, delivery('dlv_5', '{"action":"opened","number":12}', { event: 'pull_request' }));
		assert.strictEqual(plan.kind, 'run');
		if (plan.kind === 'run') {
			assert.strictEqual(plan.display, 'Review #12');
			assert.ok(plan.text.includes('Review #12'));
			assert.deepStrictEqual(plan.missing, []);
		}
	});
});

