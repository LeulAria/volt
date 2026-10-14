/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { api } from '../lib/api';
import { useOrg } from '../lib/data';
import { formatCount } from '../lib/format';
import { useQuery } from '../lib/query';
import { Tag } from '../ui/controls';
import { ErrorView, type IColumn, Loading, Page, Table } from '../ui/layout';

interface IActivityRow { readonly kind: string; readonly name: string; readonly total: number; readonly users: number }

const KIND_LABEL: Record<string, string> = { run: 'Agent runs', tool: 'Tool calls', mcp_call: 'MCP calls', edit: 'Edits', access_denied: 'Access denied', skill_used: 'Skills used', session: 'Sessions' };

/** What agents did on developers' machines, as reported by Volt (beyond what the gateway sees). */
export default function ActivityEditor() {
	const { orgId } = useOrg();
	const { data, error, refetch } = useQuery(`${orgId}:activity`, () => api.get<IActivityRow[]>('/activity'));
	if (error) {
		return <ErrorView error={error} retry={refetch} />;
	}
	if (!data) {
		return <Loading page />;
	}
	const columns: IColumn<IActivityRow>[] = [
		{ id: 'kind', title: 'Kind', width: 160, sort: r => r.kind, render: r => <Tag tone={r.kind === 'access_denied' ? 'warn' : undefined}>{KIND_LABEL[r.kind] ?? r.kind}</Tag> },
		{ id: 'name', title: 'Name', sort: r => r.name, render: r => <span className="mono cell-primary">{r.name || '—'}</span> },
		{ id: 'total', title: 'Count', width: 110, align: 'right', sort: r => r.total, render: r => formatCount(r.total) },
		{ id: 'users', title: 'Developers', width: 110, align: 'right', sort: r => r.users, render: r => formatCount(r.users) },
	];
	return (
		<Page title="Agent Activity" wide subtitle="Last 30 days of client-side events Volt reports: agent runs, tool and MCP calls, edits kept, and actions the access policy denied.">
			<Table columns={columns} rows={data} rowKey={r => `${r.kind}:${r.name}`} initialSort={{ column: 'total', desc: true }} emptyIcon="robot" empty="No activity reported yet. Volt reports it once developers connect." />
		</Page>
	);
}
