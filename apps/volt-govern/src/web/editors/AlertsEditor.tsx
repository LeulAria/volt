/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAlert } from '../../shared/api';
import { api } from '../lib/api';
import { keys, useAlerts, useOrg } from '../lib/data';
import { formatDateTime } from '../lib/format';
import { invalidate } from '../lib/query';
import { Button, Tag } from '../ui/controls';
import { Codicon } from '../ui/icons';
import { ErrorView, type IColumn, Loading, Page, Table } from '../ui/layout';
import { attempt } from '../ui/overlays';

export default function AlertsEditor() {
	const { orgId } = useOrg();
	const { data, error, refetch } = useAlerts(orgId);
	if (error) {
		return <ErrorView error={error} retry={refetch} />;
	}
	if (!data) {
		return <Loading page />;
	}
	const ack = async (a: IAlert) => {
		await attempt(() => api.post(`/alerts/${a.id}/ack`));
		invalidate(keys.alerts(orgId), keys.overview(orgId));
	};
	const columns: IColumn<IAlert>[] = [
		{ id: 'sev', title: '', width: 36, render: a => <Codicon name={a.severity === 'error' ? 'error' : a.severity === 'warning' ? 'warning' : 'info'} className={a.severity === 'error' ? 'err-text' : a.severity === 'warning' ? 'warn-text' : 'muted'} /> },
		{ id: 'message', title: 'Alert', render: a => <span className="cell-primary" title={a.message}>{a.message}</span> },
		{ id: 'kind', title: 'Kind', width: 110, sort: a => a.kind, render: a => <Tag>{a.kind}</Tag> },
		{ id: 'time', title: 'Raised', width: 170, sort: a => a.createdAt, render: a => formatDateTime(a.createdAt) },
		{ id: 'actions', title: '', width: 130, render: a => a.acknowledgedAt ? <span className="faint">Acknowledged</span> : <Button size="sm" onClick={e => { e.stopPropagation(); void ack(a); }}>Acknowledge</Button> },
	];
	return (
		<Page title="Alerts" subtitle="Budgets crossing 80% and 100%, and other events that need a person. Each alert is raised once per period.">
			<Table columns={columns} rows={data} rowKey={a => a.id} initialSort={{ column: 'time', desc: true }} emptyIcon="bell-slash" empty="No alerts." />
		</Page>
	);
}
