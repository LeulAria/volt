import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { colors } from '@/lib/theme';

interface IconProps {
	readonly size?: number;
	readonly color?: string;
}

// The agent window's own glyphs (agentEditorIcons.ts) where it has one, drawn with react-native-svg.

export function SendIcon({ size = 18, color = '#181818' }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24">
			<Path d="m19.03 9.47l-6.145-6.145a1.26 1.26 0 0 0-1.77 0L4.97 9.47l1.06 1.06l5.22-5.22V21h1.5V5.31l5.22 5.22z" fill={color} stroke={color} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
		</Svg>
	);
}

export function StopIcon({ size = 12, color = '#181818' }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 64 384 384">
			<Path d="M0 128c0-35.3 28.7-64 64-64h256c35.3 0 64 28.7 64 64v256c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64z" fill={color} />
		</Svg>
	);
}

export function PlusIcon({ size = 16, color = colors.textSecondary }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
			<Path d="M7 2.5v9M2.5 7h9" stroke={color} strokeWidth={1.1} strokeLinecap="round" />
		</Svg>
	);
}

export function ChevronDownIcon({ size = 10, color = colors.textTertiary }: IconProps) {
	return (
		<Svg width={size} height={size * 7 / 16} viewBox="0 0 16 7">
			<Path d="M8 6.5a.47.47 0 0 1-.35-.15l-4.5-4.5c-.2-.2-.2-.51 0-.71s.51-.2.71 0l4.15 4.15l4.14-4.14c.2-.2.51-.2.71 0s.2.51 0 .71l-4.5 4.5c-.1.1-.23.15-.35.15Z" fill={color} />
		</Svg>
	);
}

export function BackIcon({ size = 22, color = colors.text }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
			<Path d="M15 5l-7 7 7 7" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
		</Svg>
	);
}

export function NewChatIcon({ size = 18, color = colors.text }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
			<Path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
			<Path d="M17.5 3.5a2.12 2.12 0 0 1 3 3L13 14l-4 1 1-4 7.5-7.5z" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
		</Svg>
	);
}

export function GearIcon({ size = 18, color = colors.textSecondary }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
			<Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={1.5} />
			<Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke={color} strokeWidth={1.5} />
		</Svg>
	);
}

export function BranchIcon({ size = 12, color = colors.textTertiary }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
			<Circle cx={4.5} cy={3.5} r={1.5} stroke={color} strokeWidth={1.1} />
			<Circle cx={4.5} cy={12.5} r={1.5} stroke={color} strokeWidth={1.1} />
			<Circle cx={11.5} cy={5} r={1.5} stroke={color} strokeWidth={1.1} />
			<Path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" stroke={color} strokeWidth={1.1} />
		</Svg>
	);
}

export function FolderIcon({ size = 14, color = colors.textSecondary }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
			<Path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" stroke={color} strokeWidth={1.1} strokeLinejoin="round" />
		</Svg>
	);
}

export function CheckIcon({ size = 14, color = colors.text }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
			<Path d="M3 8.5l3 3 7-7" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
		</Svg>
	);
}

export function ArrowDownIcon({ size = 14, color = colors.textSecondary }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
			<Path d="M8 2.5v11M3.5 9L8 13.5 12.5 9" stroke={color} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
		</Svg>
	);
}

export function ScanIcon({ size = 18, color = colors.text }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
			<Path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
			<Rect x={8} y={8} width={8} height={8} rx={1.5} stroke={color} strokeWidth={1.4} />
		</Svg>
	);
}

/** Access modes, after the window's accessIcons: a shield that fills as access widens. */
export function ShieldIcon({ size = 14, color = colors.textSecondary, filled = false }: IconProps & { readonly filled?: boolean }) {
	return (
		<Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
			<Path d="M8 1.8l5 1.9v4c0 3.1-2.1 5.5-5 6.5-2.9-1-5-3.4-5-6.5v-4z" stroke={color} strokeWidth={1.2} strokeLinejoin="round" fill={filled ? color : 'none'} fillOpacity={filled ? 0.35 : 0} />
		</Svg>
	);
}

/** Codicon `dashboard` (the limit banner's gauge). */
export function GaugeIcon({ size = 15, color = colors.textTertiary }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
			<Path d="M2.3 11.5a6 6 0 1 1 11.4 0" stroke={color} strokeWidth={1.1} strokeLinecap="round" />
			<Path d="M8 9.2 10.6 5.6" stroke={color} strokeWidth={1.1} strokeLinecap="round" />
			<Circle cx={8} cy={9.6} r={1} fill={color} />
		</Svg>
	);
}
