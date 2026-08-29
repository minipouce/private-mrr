import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, radius, type } from '../theme/index';
import { monthLabel, moneyCompact } from '../lib/format';
import type { MonthlyPoint } from '../api/types';

interface Props {
  data: MonthlyPoint[];
  color?: string;
  currency?: string;
}

/** Histogramme mensuel. Le mois courant est mis en avant, les autres en retrait. */
export function Bars({ data, color = colors.accent, currency = 'eur' }: Props) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.cents), 1);

  return (
    <View style={styles.wrap}>
      {data.map((point, index) => {
        const isLast = index === data.length - 1;
        const ratio = point.cents / max;
        return (
          <View key={point.month} style={styles.column}>
            <Text
              style={[styles.value, { color: isLast ? colors.text : colors.textFaint }]}
              numberOfLines={1}
            >
              {moneyCompact(point.cents, currency)}
            </Text>
            <View style={styles.track}>
              <View
                style={[
                  styles.bar,
                  {
                    // 3 % minimum : une barre nulle doit rester visible comme
                    // un mois à zéro, pas comme une donnée manquante.
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
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 168 },
  column: { flex: 1, alignItems: 'center', height: '100%' },
  value: { ...type.caption, fontSize: 9, marginBottom: 4 },
  track: { flex: 1, width: '100%', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: radius.sm, minHeight: 3 },
  label: { ...type.caption, fontSize: 10, color: colors.textFaint, marginTop: 6 },
});
