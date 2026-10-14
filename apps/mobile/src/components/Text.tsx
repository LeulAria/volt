import { Text as RNText, TextProps, StyleSheet } from 'react-native';
import { colors, fonts, FontWeight } from '@/lib/theme';

export interface AppTextProps extends TextProps {
	readonly weight?: FontWeight;
	readonly size?: number;
	readonly color?: string;
}

/** Text in the system font. Code uses `codeFont` instead. */
export function Text({ weight = 'regular', size = 14, color = colors.text, style, ...rest }: AppTextProps) {
	return <RNText {...rest} style={[styles.base, { ...fonts[weight], fontSize: size, color, lineHeight: Math.round(size * 1.45) }, style]} />;
}

const styles = StyleSheet.create({
	base: { includeFontPadding: false, letterSpacing: -0.1 },
});
