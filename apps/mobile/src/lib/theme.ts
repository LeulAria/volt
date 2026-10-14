import { VOLT_FONT_FAMILY } from '@/core/voltCore';

/**
 * The agent window's colors (Cursor Dark, as the window draws them) and Volt's typeface. Values
 * come from the window's theme (src/vs/workbench/contrib/voltAgentWeb/browser/media/desktopTheme.css).
 */
export const colors = {
	background: '#181818',
	sidebar: '#141414',
	surface: 'rgba(240, 240, 240, 0.04)',
	surfaceRaised: '#1f1f1f',
	pressed: 'rgba(240, 240, 240, 0.07)',
	selected: 'rgba(240, 240, 240, 0.12)',
	border: 'rgba(240, 240, 240, 0.08)',
	borderStrong: 'rgba(240, 240, 240, 0.15)',
	text: '#f0f0f0',
	textSecondary: 'rgba(240, 240, 240, 0.7)',
	textTertiary: 'rgba(240, 240, 240, 0.5)',
	textQuaternary: 'rgba(240, 240, 240, 0.35)',
	link: '#81a1c1',
	blue: '#3794ff',
	green: '#3fa266',
	red: '#e34671',
	warning: '#f0a020',
	brand: '#1B58D4',
} as const;

/** Volt's UI typeface in every client is the system font. `VOLT_FONT_FAMILY` is the stack the web uses. */
export const CSS_FONT_STACK = VOLT_FONT_FAMILY;

/** Weights of the system font. Spread into a style: `{ ...fonts.regular }`. */
export const fonts = {
	light: { fontWeight: '300' },
	regular: { fontWeight: '400' },
	medium: { fontWeight: '500' },
	semibold: { fontWeight: '600' },
	bold: { fontWeight: '700' },
} as const;

/** Only code uses the monospace font (Geist Mono, loaded in `_layout.tsx`). */
export const codeFont = 'GeistMono_400Regular';

export type FontWeight = keyof typeof fonts;

export const radius = { sm: 6, md: 10, lg: 14, xl: 20, pill: 999 } as const;
