import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, radius, space, type } from '../theme';
import { money, moneyCompact } from '../lib/format';
import type { GoalProgress } from '../api/types';
import { t } from '../i18n';

/**
 * Avancement vers un objectif de revenu.
 *
 * La barre est plafonnée à 100 % pour rester lisible, mais le pourcentage réel
 * est affiché tel quel : dépasser son objectif mérite d'être vu.
 */
export function GoalBar({
  goal,
  color = colors.accent,
  currency = 'eur',
  compact = false,
}: {
  goal: GoalProgress;
  color?: string;
  currency?: string;
  compact?: boolean;
}) {
  const reached = goal.percent >= 100;
  const fill = Math.min(goal.percent, 100);
  const tint = reached ? colors.positive : color;

  return (
    <View style={compact ? styles.compactWrap : styles.wrap}>
      <View style={styles.head}>
        <Text style={[styles.label, compact && styles.labelCompact]}>
          {reached ? '🎯 ' : ''}
          {goal.kind.toUpperCase()} · {t('goalTarget')} {moneyCompact(goal.targetCents, currency)}
        </Text>
        <Text style={[styles.percent, { color: tint }, compact && styles.percentCompact]}>
          {goal.percent.toFixed(0)} %
        </Text>
      </View>

      <View style={[styles.track, compact && styles.trackCompact]}>
        <View style={[styles.fill, { width: `${Math.max(fill, 1)}%`, backgroundColor: tint }]} />
      </View>

      {!compact && (
        <Text style={styles.remaining}>
          {reached
            ? t('goalExceededBy', { amount: money(goal.currentCents - goal.targetCents, currency) })
            : t('goalRemaining', { amount: money(goal.remainingCents, currency) })}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 7 },
  compactWrap: { gap: 4 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { ...type.caption, color: colors.textFaint, fontSize: 10 },
  labelCompact: { fontSize: 9 },
  percent: { ...type.caption, ...type.tabular, fontSize: 11.5 },
  percentCompact: { fontSize: 10 },
  track: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHi,
    overflow: 'hidden',
  },
  trackCompact: { height: 4 },
  fill: { height: '100%', borderRadius: radius.pill },
  remaining: { ...type.caption, color: colors.textFaint, fontSize: 10.5 },
});
