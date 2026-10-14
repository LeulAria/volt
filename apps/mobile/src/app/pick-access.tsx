import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { ACCESS_MODE_OPTIONS, type VoltAccessMode } from '@/core/voltCore';
import { ShieldIcon } from '@/components/Icons';
import { SheetList } from '@/components/SheetList';
import { useServerVersion, useServices } from '@/lib/connection';

export default function PickAccess() {
	const services = useServices();
	useServerVersion(services);
	const mode = services.runtime.getAccessMode();
	const items = ACCESS_MODE_OPTIONS.map(option => ({ key: option.id, label: option.label, description: option.description, icon: <ShieldIcon size={16} filled={option.id === 'full-access' || option.id === 'auto'} />, selected: option.id === mode }));
	return (
		<SheetList title="Access" items={items} onPick={id => {
			void Haptics.selectionAsync();
			void services.runtime.setAccessMode(id as VoltAccessMode);
			router.back();
		}} />
	);
}
