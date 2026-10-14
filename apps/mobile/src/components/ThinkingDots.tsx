import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { THINKING_DOTS_SPEED, thinkingDotOpacities } from '@/core/voltCore';

/** The working indicator from the agent window's status chip: a trail running round a 3x3 grid. */
export function ThinkingDots({ active = true }: { readonly active?: boolean }) {
	const [step, setStep] = useState(0);
	useEffect(() => {
		if (!active) {
			return;
		}
		const timer = setInterval(() => setStep(s => s + 1), THINKING_DOTS_SPEED);
		return () => clearInterval(timer);
	}, [active]);
	const opacities = thinkingDotOpacities(step);
	return (
		<View style={styles.grid} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
			{opacities.map((opacity, index) => <View key={index} style={[styles.dot, { opacity }]} />)}
		</View>
	);
}

const styles = StyleSheet.create({
	grid: { width: 13, height: 13, flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
	dot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: '#d0d0d0' },
});
