/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import type { IDevice } from '../../shared/api';
import { api } from '../lib/api';
import { keys, useDevices, useOrg } from '../lib/data';
import { formatDateTime, platformName, timeAgo } from '../lib/format';
import { invalidate } from '../lib/query';
import { Button, FilterInput, Person, Select, Tag } from '../ui/controls';
import { ErrorView, type IColumn, Loading, Page, Table } from '../ui/layout';
import { attempt, confirm } from '../ui/overlays';
import { open } from '../workbench/commands';

export default function DevicesEditor() {
	const { orgId, can } = useOrg();
	const { data, error, refetch } = useDevices(orgId);
	const [filter, setFilter] = useState('');
	const [state, setState] = useState('active');
	if (error) {
		return <ErrorView error={error} retry={refetch} />;
	}
	if (!data) {
		return <Loading page />;
	}
	const revoke = async (d: IDevice) => {
		if (await confirm({ title: `Revoke ${d.name}?`, message: `Volt on this computer stops working for ${d.userName ?? d.userEmail ?? 'its owner'} at once; gateway credentials issued to it are refused.`, primary: 'Revoke', danger: true })) {
			await attempt(() => api.post(`/devices/${d.id}/revoke`), 'Device revoked');
			invalidate(keys.devices(orgId), keys.overview(orgId));
		}
	};
	const q = filter.toLowerCase();
	const rows = data.filter(d => (state === 'all' || (state === 'active') === !d.revokedAt) && (!q || `${d.name} ${d.userName} ${d.userEmail} ${d.platform}`.toLowerCase().includes(q)));
	const columns: IColumn<IDevice>[] = [
		{ id: 'name', title: 'Device', sort: d => d.name, render: d => <span className="cell-primary">{d.name}</span> },
		{ id: 'user', title: 'Member', sort: d => d.userName ?? '', render: d => <Person name={d.userName ?? d.userEmail ?? d.userId} onOpen={() => open.member(d.userId, d.userName ?? d.userEmail ?? d.userId)} /> },
		{ id: 'platform', title: 'Platform', width: 150, sort: d => d.platform, render: d => `${platformName(d.platform)}${d.appVersion ? ` · Volt ${d.appVersion}` : ''}` },
		{ id: 'registered', title: 'Registered', width: 160, sort: d => d.createdAt, render: d => formatDateTime(d.createdAt) },
		{ id: 'seen', title: 'Last seen', width: 120, sort: d => d.lastSeenAt ?? '', render: d => timeAgo(d.lastSeenAt) },
		{ id: 'state', title: '', width: 110, render: d => d.revokedAt ? <Tag tone="err" title={formatDateTime(d.revokedAt)}>revoked</Tag> : can({ device: ['revoke'] }) ? <span className="row-actions"><Button size="sm" variant="danger" onClick={() => void revoke(d)}>Revoke</Button></span> : <Tag tone="ok">active</Tag> },
	];
	return (
		<Page title="Devices" wide subtitle="Each Volt installation registers a key pair; gateway credentials are bound to it. Revoking a device cuts it off at once, and removing a member (or deprovisioning them through SCIM) revokes all their devices.">
			<div className="row" style={{ marginBottom: 10 }}>
				<div style={{ width: 280 }}><FilterInput value={filter} onChange={setFilter} placeholder="Filter devices" /></div>
				<Select compact value={state} onChange={setState} options={[{ value: 'active', label: 'Active' }, { value: 'revoked', label: 'Revoked' }, { value: 'all', label: 'All' }]} />
			</div>
			<Table columns={columns} rows={rows} rowKey={d => d.id} initialSort={{ column: 'seen', desc: true }} emptyIcon="device-desktop" empty="No devices." />
		</Page>
	);
}
