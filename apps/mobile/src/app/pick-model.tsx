import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { currentModelRef, splitModelDisplayName } from '@/core/voltCore';
import { BrandIcon } from '@/components/BrandIcon';
import { SheetList } from '@/components/SheetList';
import { useServerVersion, useServices } from '@/lib/connection';
import { setPickedModel, usePickedModel } from '@/lib/modelChoice';

export default function PickModel() {
	const services = useServices();
	useServerVersion(services);
	const picked = usePickedModel();
	const current = currentModelRef(services, undefined, picked);
	const items = services.runtime.listCatalog()
		.filter(item => services.runtime.isModelEnabled(item.ref))
		.map(item => ({ key: item.ref, label: splitModelDisplayName(item.label).name, description: item.detail, icon: <BrandIcon providerId={item.providerId} size={16} />, selected: item.ref === current }));
	return (
		<SheetList title="Model" items={items} empty="No models are enabled. Turn some on in Volt." onPick={ref => {
			void Haptics.selectionAsync();
			setPickedModel(ref);
			router.back();
		}} />
	);
}
