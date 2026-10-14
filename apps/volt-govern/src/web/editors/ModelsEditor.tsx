/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IPolicyRecord } from '../../shared/api';
import { DEFAULT_ORG_POLICY, matchesAny } from '../../shared/policy';
import { presetFor } from '../../shared/providers';
import { api } from '../lib/api';
import { keys, useCredentials, useOrg, usePolicies } from '../lib/data';
import { invalidate } from '../lib/query';
import { Button, Tag } from '../ui/controls';
import { type IColumn, Loading, Page, Table } from '../ui/layout';
import { attempt } from '../ui/overlays';
import { open } from '../workbench/commands';

interface IModelRow {
	readonly ref: string;
	readonly provider: string;
	readonly model: string;
	readonly keys: readonly string[];
	readonly allowed: boolean;
	readonly denied: boolean;
}

/**
 * Every model the organization's keys offer, and whether the organization policy allows it.
 * Blocking here adds the model to the organization deny list (teams can narrow further).
 */
export default function ModelsEditor() {
	const { orgId, can } = useOrg();
	const credentials = useCredentials(can({ credential: ['read'] }) ? orgId : '');
	const policies = usePolicies(orgId);
	if (!credentials.data || !policies.data) {
		return <Loading page />;
	}
	const orgRecord = policies.data.find(p => p.scopeType === 'org');
	const doc = orgRecord?.document ?? DEFAULT_ORG_POLICY;
	const rows = new Map<string, IModelRow>();
	for (const c of credentials.data.filter(x => x.status === 'active')) {
		const list = c.models.length ? c.models : presetFor(c.provider)?.models ?? [];
		for (const model of list) {
			const ref = `${c.provider}/${model}`;
			const prev = rows.get(ref);
			const denied = matchesAny(ref, doc.models?.deny);
			const allowed = !denied && (!doc.models?.allow || matchesAny(ref, doc.models.allow));
			rows.set(ref, { ref, provider: c.provider, model, keys: [...(prev?.keys ?? []), c.label], allowed, denied });
		}
	}
	const save = async (deny: string[]) => {
		const record = orgRecord as IPolicyRecord | undefined;
		await attempt(() => api.put(`/policies/org/${orgId}`, { document: { ...doc, models: { ...doc.models, deny } }, version: record && record.version > 0 ? record.version : undefined }), 'Organization policy updated');
		invalidate(keys.policies(orgId));
	};
	const toggle = (row: IModelRow) => {
		const deny = [...(doc.models?.deny ?? [])];
		void save(row.denied ? deny.filter(d => d !== row.ref) : [...deny, row.ref]);
	};
	const columns: IColumn<IModelRow>[] = [
		{ id: 'model', title: 'Model', sort: r => r.model, render: r => <span className="cell-primary mono">{r.model}</span> },
		{ id: 'provider', title: 'Provider', width: 150, sort: r => r.provider, render: r => presetFor(r.provider)?.label ?? r.provider },
		{ id: 'keys', title: 'Served by', render: r => <span className="tag-list">{r.keys.map(k => <Tag key={k}>{k}</Tag>)}</span> },
		{ id: 'policy', title: 'Organization policy', width: 170, sort: r => (r.allowed ? 0 : 1), render: r => r.allowed ? <Tag tone="ok" icon="check">allowed</Tag> : <Tag tone="err" icon="circle-slash">{r.denied ? 'blocked' : 'not in allow list'}</Tag> },
		{ id: 'actions', title: '', width: 110, render: r => can({ policy: ['update'] }) && (r.allowed || r.denied) ? <span className="row-actions"><Button size="sm" variant={r.denied ? 'secondary' : 'danger'} onClick={() => toggle(r)}>{r.denied ? 'Unblock' : 'Block'}</Button></span> : null },
	];
	return (
		<Page title="Model Catalog" wide subtitle="Models offered by the organization's active keys. Developers address them by id, or as provider/model when two providers share an id."
			actions={can({ policy: ['read'] }) ? <Button icon="law" onClick={() => open.policy('org', orgId, 'Organization Policy', true)}>Model Rules</Button> : undefined}>
			<Table columns={columns} rows={[...rows.values()]} rowKey={r => r.ref} initialSort={{ column: 'provider' }} emptyIcon="sparkle" empty="No models: add a provider key, and list models on it (or use a provider with a default list)." />
		</Page>
	);
}
