import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { colors, radius, space, type } from '../theme/index';
import { money, moneyCompact, percent, signed } from '../lib/format';
import type { Metrics } from '../api/types';
import { ProjectLogo } from './ProjectLogo';
import { GoalBar } from './GoalBar';
import { t, plural } from '../i18n';

/**
 * Carte de projet : MRR en vedette, part du total en barre, et le mouvement
 * net du mois — ce qui permet de repérer d'un coup d'œil un projet qui décroche.
 */
export function ProjectCard({
  metrics,
  share,
  onPress,
}: {
  metrics: Metrics;
  share: number;
  onPress: () => void;
}) {
  const net = metrics.movement.netCents;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.header}>
        <View style={styles.identity}>
          <ProjectLogo
            projectId={metrics.projectId}
            color={metrics.color}
            hasLogo={metrics.hasLogo}
            size={26}
          />
          <Text style={styles.name} numberOfLines={1}>
            {metrics.name}
          </Text>
        </View>
        <Text style={styles.subs}>
          {metrics.activeSubscribers}{' '}
          {plural(metrics.activeSubscribers, 'subscriber', 'subscribers')}
        </Text>
      </View>

      <View style={styles.figures}>
        <View style={styles.mrrBlock}>
          <Text style={styles.mrr} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
            {money(metrics.mrrCents, metrics.currency)}
          </Text>
          <Text style={styles.mrrLabel}>MRR</Text>
        </View>

        <View style={styles.side}>
          <Text style={styles.sideValue}>{moneyCompact(metrics.mtdCents, metrics.currency)}</Text>
          <Text style={styles.sideLabel}>
            {t('thisMonth').toLowerCase()}
            {metrics.mtdVsPrevPct !== null ? ` · ${percent(metrics.mtdVsPrevPct)}` : ''}
          </Text>
        </View>
      </View>

      {metrics.goal && (
        <GoalBar goal={metrics.goal} color={metrics.color} currency={metrics.currency} compact />
      )}

      <View style={styles.footer}>
        <View style={styles.shareTrack}>
          <View
            style={[
              styles.shareFill,
              { width: `${Math.max(share * 100, 1.5)}%`, backgroundColor: metrics.color },
            ]}
          />
        </View>
        <Text style={styles.shareText}>{(share * 100).toFixed(0)} %</Text>
        {net !== 0 && (
          <Text
            style={[
              styles.net,
              { color: net > 0 ? colors.positive : colors.negative },
            ]}
          >
            {signed(net, metrics.currency)}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    padding: space.lg,
    gap: space.md,
  },
  pressed: { opacity: 0.65, transform: [{ scale: 0.985 }] },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
  name: { ...type.body, color: colors.text, fontSize: 15, fontWeight: '600', flex: 1 },
  subs: { ...type.caption, color: colors.textFaint, fontSize: 11 },
  figures: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.md },
  mrrBlock: { flex: 1, gap: 1 },
  mrr: { ...type.title, ...type.tabular, color: colors.text, fontSize: 25 },
  mrrLabel: { ...type.caption, color: colors.textFaint, fontSize: 10 },
  side: { alignItems: 'flex-end', gap: 1 },
  sideValue: { ...type.body, ...type.tabular, color: colors.textDim, fontSize: 14, fontWeight: '600' },
  sideLabel: { ...type.caption, color: colors.textFaint, fontSize: 10 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  shareTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceHi,
    overflow: 'hidden',
  },
  shareFill: { height: '100%', borderRadius: 2 },
  shareText: { ...type.caption, color: colors.textFaint, fontSize: 10, minWidth: 30, textAlign: 'right' },
  net: { ...type.caption, ...type.tabular, fontSize: 11 },
});
