import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { colors, radius, space, type } from '../theme/index';
import { monthLabel, moneyCompact } from '../lib/format';
import { t } from '../i18n';
import type { MonthlyPoint } from '../api/types';

interface Props {
  data: MonthlyPoint[];
  color?: string;
  currency?: string;
}

type Mode = 'cash' | 'mrr';

/**
 * Monthly histogram. The current month is highlighted, the others recede.
 *
 * Two readings of the same months: what came in, and what the MRR stood at when
 * each month closed. Cash is the default because it is the figure the rest of
 * the screen is built on; the recurring level answers a different question,
 * "where was I in June", which a cash bar cannot.
 */
export function Bars({ data, color = colors.accent, currency = 'eur' }: Props) {
  const [mode, setMode] = useState<Mode>('cash');
  // A server older than this chart sends no MRR history: rather than draw an
  // empty second view, the switch simply does not appear.
  const hasMrr = data.some((point) => typeof point.mrrCents === 'number');
  const showMrr = mode === 'mrr' && hasMrr;

  if (data.length === 0) return null;

  const valueOf = (point: MonthlyPoint) => (showMrr ? (point.mrrCents ?? 0) : point.cents);
  const max = Math.max(...data.map(valueOf), 1);

  return (
    <View>
      {hasMrr && (
        <View style={styles.switch}>
          <Chip label={t('chartCash')} active={!showMrr} onPress={() => setMode('cash')} />
          <Chip label={t('chartMrr')} active={showMrr} onPress={() => setMode('mrr')} />
        </View>
      )}

      <View style={styles.wrap}>
        {data.map((point, index) => {
          const isLast = index === data.length - 1;
          const value = valueOf(point);
          const ratio = value / max;
          return (
            <View key={point.month} style={styles.column}>
              <Text
                style={[styles.value, { color: isLast ? colors.text : colors.textFaint }]}
                numberOfLines={1}
              >
                {moneyCompact(value, currency)}
              </Text>
              <View style={styles.track}>
                <View
                  style={[
                    styles.bar,
                    {
                      // 3% minimum: an empty bar must still read as a zero month,
                      // not as missing data.
                      height: `${Math.max(ratio * 100, 3)}%`,
                      backgroundColor: isLast ? color : `${color}44`,
                    },
                  ]}
                />
              </View>
              <Text style={[styles.label, isLast && { color: colors.textDim }]}>
                {monthLabel(point.month)}
              </Text>
            </View>
          );
        })}
      </View>

      {showMrr && <Text style={styles.note}>{t('mrrHistoryNote')}</Text>}
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  switch: { flexDirection: 'row', gap: 6, marginBottom: space.md },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  chipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipText: { ...type.caption, color: colors.textDim, fontSize: 11.5 },
  chipTextActive: { color: colors.accent },
  wrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 168 },
  column: { flex: 1, alignItems: 'center', height: '100%' },
  value: { ...type.caption, fontSize: 9, marginBottom: 4 },
  track: { flex: 1, width: '100%', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: radius.sm, minHeight: 3 },
  label: { ...type.caption, fontSize: 10, color: colors.textFaint, marginTop: 6 },
  note: { ...type.caption, color: colors.textFaint, fontSize: 10.5, marginTop: space.sm, lineHeight: 15 },
});
