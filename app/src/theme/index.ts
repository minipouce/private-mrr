import type { TextStyle } from 'react-native';

/**
 * Design system: dark, dense, numbers first.
 * A single source of truth for colours, spacing and typography.
 */
export const colors = {
  bg: '#08090D',
  bgElevated: '#0E1016',
  surface: '#13161F',
  surfaceHi: '#1B1F2B',
  border: '#232838',
  borderSoft: '#1A1E2A',

  text: '#F2F4F8',
  textDim: '#9AA1B4',
  textFaint: '#5C6379',

  accent: '#6366F1',
  accentSoft: 'rgba(99, 102, 241, 0.14)',

  positive: '#22D39A',
  positiveSoft: 'rgba(34, 211, 154, 0.13)',
  negative: '#FF5C7A',
  negativeSoft: 'rgba(255, 92, 122, 0.13)',
  warning: '#FFB020',
  warningSoft: 'rgba(255, 176, 32, 0.13)',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

/**
 * `tabular` aligns digits on a fixed width: without it, an amount updating live
 * makes the whole layout jitter.
 *
 * Styles are typed `TextStyle` rather than frozen with `as const`: React Native
 * expects a mutable `fontVariant` and rejects a readonly tuple.
 */
export const type = {
  hero:    { fontSize: 46, fontWeight: '700', letterSpacing: -1.6 },
  title:   { fontSize: 26, fontWeight: '700', letterSpacing: -0.6 },
  heading: { fontSize: 18, fontWeight: '600', letterSpacing: -0.3 },
  body:    { fontSize: 15, fontWeight: '500' },
  label:   { fontSize: 13, fontWeight: '600' },
  caption: { fontSize: 11.5, fontWeight: '600', letterSpacing: 0.4 },
  tabular: { fontVariant: ['tabular-nums'] },
} satisfies Record<string, TextStyle>;

/** Delta colour: green when positive, red when negative, neutral at zero. */
export function deltaColor(value: number): string {
  if (value > 0) return colors.positive;
  if (value < 0) return colors.negative;
  return colors.textDim;
}
