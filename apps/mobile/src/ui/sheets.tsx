/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IconName, IToast } from '@volt/client-core';
import { type ReactNode, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp, SlideInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOptionalClient, useToasts } from '../state/client';
import { useTheme } from '../theme/theme';
import { Button, haptic, Icon, T, Tap } from './core';

/** A bottom sheet in Volt's raised surface, for pickers and action lists. */
export function Sheet({ visible, onClose, title, subtitle, children, scroll = true }: {
	readonly visible: boolean;
	readonly onClose: () => void;
	readonly title?: string;
	readonly subtitle?: string;
	readonly children: ReactNode;
	readonly scroll?: boolean;
}) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	return (
		<Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
			<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end' }}>
				<Pressable style={[StyleSheet.absoluteFill, { backgroundColor: p.overlay }]} onPress={onClose} accessibilityLabel="Close" />
				<Animated.View entering={SlideInDown.duration(260)} style={{ backgroundColor: p.raised, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '86%', paddingBottom: Math.max(insets.bottom, 12), borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke }}>
					<View style={{ alignItems: 'center', paddingTop: 8 }}>
						<View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: p.fillStrong }} />
					</View>
					{title ? (
						<View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>
							<T variant="title3" weight="600">{title}</T>
							{subtitle ? <T variant="small" color={p.fgTertiary} style={{ marginTop: 2 }}>{subtitle}</T> : null}
						</View>
					) : null}
					{scroll ? <ScrollView bounces={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8 }}>{children}</ScrollView> : <View style={{ paddingHorizontal: 12 }}>{children}</View>}
				</Animated.View>
			</KeyboardAvoidingView>
		</Modal>
	);
}

export interface ISheetAction {
	readonly label: string;
	readonly icon?: IconName;
	readonly detail?: string;
	readonly destructive?: boolean;
	readonly checked?: boolean;
	readonly disabled?: boolean;
	readonly onPress?: () => void;
	/** A group heading instead of an action. */
	readonly header?: boolean;
	/** A coloured dot instead of an icon (modes). */
	readonly dot?: string;
}

export function SheetRow({ action, onDone }: { readonly action: ISheetAction; readonly onDone: () => void }) {
	const { p } = useTheme();
	if (action.header) {
		return <T variant="caption" weight="700" color={p.fgTertiary} style={{ paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6, letterSpacing: 0.6, textTransform: 'uppercase' }}>{action.label}</T>;
	}
	const color = action.destructive ? p.danger : p.fg;
	return (
		<Tap
			disabled={action.disabled}
			haptics="selection"
			onPress={() => {
				onDone();
				action.onPress?.();
			}}
			style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 50, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12 }}
		>
			{action.dot ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: action.dot, marginHorizontal: 5 }} /> : action.icon ? <Icon name={action.icon} size={20} color={action.destructive ? p.danger : p.fgSecondary} /> : null}
			<View style={{ flex: 1 }}>
				<T variant="callout" color={color}>{action.label}</T>
				{action.detail ? <T variant="footnote" color={p.fgTertiary} numberOfLines={2}>{action.detail}</T> : null}
			</View>
			{action.checked ? <Icon name="check" size={18} color={p.accent} strokeWidth={2.2} /> : null}
		</Tap>
	);
}

export function ActionSheet({ visible, onClose, title, subtitle, actions }: { readonly visible: boolean; readonly onClose: () => void; readonly title?: string; readonly subtitle?: string; readonly actions: readonly ISheetAction[] }) {
	return (
		<Sheet visible={visible} onClose={onClose} title={title} subtitle={subtitle}>
			{actions.map((action, i) => <SheetRow key={`${i}:${action.label}`} action={action} onDone={onClose} />)}
		</Sheet>
	);
}

/** A line of text (rename a chat, a device). */
export function InputSheet({ visible, onClose, title, initial, placeholder, confirm = 'Save', onSubmit }: {
	readonly visible: boolean;
	readonly onClose: () => void;
	readonly title: string;
	readonly initial?: string;
	readonly placeholder?: string;
	readonly confirm?: string;
	readonly onSubmit: (value: string) => void;
}) {
	const { p } = useTheme();
	const [value, setValue] = useState(initial ?? '');
	useEffect(() => {
		if (visible) {
			setValue(initial ?? '');
		}
	}, [visible, initial]);
	const submit = () => {
		onSubmit(value);
		onClose();
	};
	return (
		<Sheet visible={visible} onClose={onClose} title={title} scroll={false}>
			<View style={{ paddingHorizontal: 8, gap: 14, paddingBottom: 8 }}>
				<TextInput
					autoFocus
					value={value}
					onChangeText={setValue}
					placeholder={placeholder}
					placeholderTextColor={p.fgQuaternary}
					onSubmitEditing={submit}
					returnKeyType="done"
					selectionColor={p.accent}
					style={{ height: 48, borderRadius: 12, paddingHorizontal: 14, backgroundColor: p.fill, color: p.fg, fontSize: 16 }}
				/>
				<View style={{ flexDirection: 'row', gap: 10 }}>
					<Button label="Cancel" variant="secondary" onPress={onClose} flex />
					<Button label={confirm} variant="primary" onPress={submit} flex />
				</View>
			</View>
		</Sheet>
	);
}

export function ConfirmSheet({ visible, onClose, title, body, confirm, destructive, onConfirm }: {
	readonly visible: boolean;
	readonly onClose: () => void;
	readonly title: string;
	readonly body?: string;
	readonly confirm: string;
	readonly destructive?: boolean;
	readonly onConfirm: () => void;
}) {
	const { p } = useTheme();
	return (
		<Sheet visible={visible} onClose={onClose} title={title} scroll={false}>
			<View style={{ paddingHorizontal: 8, gap: 16, paddingBottom: 8 }}>
				{body ? <T variant="body" color={p.fgSecondary}>{body}</T> : null}
				<View style={{ flexDirection: 'row', gap: 10 }}>
					<Button label="Cancel" variant="secondary" onPress={onClose} flex />
					<Button label={confirm} variant={destructive ? 'danger' : 'primary'} onPress={() => {
						if (destructive) {
							haptic.warning();
						}
						onConfirm();
						onClose();
					}} flex />
				</View>
			</View>
		</Sheet>
	);
}

function ToastView({ toast }: { readonly toast: IToast }) {
	const { p } = useTheme();
	const client = useOptionalClient();
	const color = toast.kind === 'error' ? p.danger : toast.kind === 'success' ? p.success : p.info;
	useEffect(() => {
		if (toast.kind === 'error') {
			haptic.error();
		}
	}, [toast.kind]);
	return (
		<Animated.View entering={FadeInUp.duration(220)} exiting={FadeOutUp.duration(180)}>
			<Tap onPress={() => client?.dismissToast(toast.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 14, backgroundColor: p.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 6 }}>
				<Icon name={toast.kind === 'error' ? 'alertCircle' : toast.kind === 'success' ? 'checkCircle' : 'info'} size={18} color={color} />
				<T variant="small" style={{ flex: 1 }} numberOfLines={3}>{toast.message}</T>
			</Tap>
		</Animated.View>
	);
}

export function Toasts() {
	const toasts = useToasts();
	const insets = useSafeAreaInsets();
	return (
		<View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 6, left: 12, right: 12, gap: 8 }}>
			{toasts.map(toast => <ToastView key={toast.id} toast={toast} />)}
		</View>
	);
}
