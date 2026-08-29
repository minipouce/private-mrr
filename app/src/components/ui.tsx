import React from 'react';
import { View, Text, StyleSheet, Pressable, type ViewStyle } from 'react-native';
import { colors, radius, space, type } from '../theme/index';

export function Card({
  children,
  style,
  padded = true,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  padded?: boolean;
}) {
  return (
    <View style={[styles.card, padded && { padding: space.lg }, style]}>{children}</View>
  );
}

export function SectionTitle({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {action && (
        <Pressable onPress={action.onPress} hitSlop={10}>
          <Text style={styles.sectionAction}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Petite statistique : libellé discret, valeur proéminente, note optionnelle. */
export function Stat({
  label,
  value,
  hint,
  hintColor,
  flex = 1,
}: {
  label: string;
  value: string;
  hint?: string;
  hintColor?: string;
  flex?: number;
}) {
  return (
    <View style={[styles.stat, { flex }]}>
      <Text style={styles.statLabel}>{label.toUpperCase()}</Text>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
        {value}
      </Text>
      {hint !== undefined && (
        <Text style={[styles.statHint, hintColor ? { color: hintColor } : null]}>{hint}</Text>
      )}
    </View>
  );
}

export function Pill({
  label,
  color = colors.textDim,
  background = colors.surfaceHi,
}: {
  label: string;
  color?: string;
  background?: string;
}) {
  return (
    <View style={[styles.pill, { backgroundColor: background }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint && <Text style={styles.emptyHint}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
    marginTop: space.xl,
  },
  sectionTitle: { ...type.heading, color: colors.text },
  sectionAction: { ...type.label, color: colors.accent },
  stat: { gap: 3 },
  statLabel: { ...type.caption, color: colors.textFaint, fontSize: 10 },
  statValue: { ...type.title, ...type.tabular, color: colors.text, fontSize: 22 },
  statHint: { ...type.caption, color: colors.textDim, fontSize: 11 },
  pill: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  pillText: { ...type.caption, fontSize: 10.5 },
  divider: { height: 1, backgroundColor: colors.borderSoft, marginVertical: space.md },
  empty: { paddingVertical: space.xxl, alignItems: 'center', gap: 6 },
  emptyTitle: { ...type.body, color: colors.textDim },
  emptyHint: { ...type.caption, color: colors.textFaint, textAlign: 'center' },
});
