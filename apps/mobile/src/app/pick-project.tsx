import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { FolderIcon } from '@/components/Icons';
import { SheetList } from '@/components/SheetList';
import { useServerVersion, useServices } from '@/lib/connection';

export default function PickProject() {
	const services = useServices();
	useServerVersion(services);
	const active = services.projects.activeProject?.id;
	const items = services.projects.projects.map(project => ({ key: project.id, label: project.displayName, description: project.root.fsPath, icon: <FolderIcon size={16} />, selected: project.id === active }));
	return (
		<SheetList title="Project" items={items} empty="No projects yet. Add one in Volt on your Mac." onPick={id => {
			void Haptics.selectionAsync();
			services.projects.selectProject(id);
			router.back();
		}} />
	);
}
