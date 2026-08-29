import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl,
  useWindowDimensions, Pressable, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useLive } from '../../src/hooks/useLive';
import { api } from '../../src/api/client';
import { colors, space, type, radius } from '../../src/theme/index';
import { money, moneyCompact, percent, signed } from '../../src/lib/format';
import { Chart } from '../../src/components/Chart';
import { Bars } from '../../src/components/Bars';
import { LiveBadge } from '../../src/components/LiveBadge';
import { ProjectCard } from '../../src/components/ProjectCard';
import { EventRow } from '../../src/components/EventRow';
import { Card, SectionTitle, Stat, EmptyState } from '../../src/components/ui';
import { GoalBar } from '../../src/components/GoalBar';
import type { DailyPoint, MonthlyPoint } from '../../src/api/types';

export default function Dashboard() {
  const { overview, events, status, error, flashId, refresh } = useLive();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const [daily, setDaily] = useState<DailyPoint[]>([]);
  const [monthly, setMonthly] = useState<MonthlyPoint[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadSeries = useCallback(async () => {
    try {
      const [d, m] = await Promise.all([api.daily(30), api.monthly(6)]);
      setDaily(d.series);
      setMonthly(m.series);
    } catch {
      // Les séries sont secondaires : leur échec ne doit pas vider l'écran.
    }
  }, []);

  useEffect(() => {
    if (status === 'unconfigured') router.replace('/setup');
  }, [status]);

  useEffect(() => {
    if (overview) void loadSeries();
    // `generatedAt` change à chaque recalcul poussé par le serveur : les
    // courbes suivent donc le direct sans polling supplémentaire.
  }, [overview?.generatedAt, loadSeries]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refresh(), loadSeries()]);
    setRefreshing(false);
  }, [refresh, loadSeries]);

  if (!overview) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        {status === 'loading' ? (
          <ActivityIndicator color={colors.accent} />
        ) : (
          <EmptyState
            title={error ?? 'Aucune donnée'}
            hint="Tire vers le bas pour réessayer, ou vérifie les réglages du serveur."
          />
        )}
      </View>
    );
  }

  const t = overview.total;
  // L'aperçu porte l'indicateur de logo par projet ; les lignes d'activité s'y réfèrent.
  const logoByProject = new Map(
    overview.projects.map((p) => [p.projectId ?? '', p.hasLogo ?? false]),
  );
  const chartWidth = width - space.lg * 2 - space.lg * 2;
  const totalMrr = Math.max(t.mrrCents, 1);
  const movement = t.movement;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + space.md, paddingBottom: space.xxl },
      ]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.topBar}>
        <View>
          <Text style={styles.eyebrow}>REVENUS CONSOLIDÉS</Text>
          <Text style={styles.projectCount}>
            {overview.projects.length} projet{overview.projects.length > 1 ? 's' : ''}
          </Text>
        </View>
        <LiveBadge status={status} />
      </View>

      {/* Hero : le MRR est le chiffre que l'on vient chercher en premier. */}
      <View style={styles.hero}>
        <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
          {money(t.mrrCents, t.currency)}
        </Text>
        <View style={styles.heroMeta}>
          <Text style={styles.heroLabel}>MRR</Text>
          <View style={styles.heroSep} />
          <Text style={styles.heroLabel}>{money(t.arrCents, t.currency)} ARR</Text>
          {movement.netCents !== 0 && (
            <>
              <View style={styles.heroSep} />
              <Text
                style={[
                  styles.heroDelta,
                  { color: movement.netCents > 0 ? colors.positive : colors.negative },
                ]}
              >
                {signed(movement.netCents, t.currency)} ce mois
              </Text>
            </>
          )}
        </View>
      </View>

      {t.goal && (
        <Card style={styles.goalCard}>
          <GoalBar goal={t.goal} currency={t.currency} />
        </Card>
      )}

      <Card style={styles.chartCard}>
        <View style={styles.chartHead}>
          <View>
            <Text style={styles.chartValue}>{money(t.last30Cents, t.currency)}</Text>
            <Text style={styles.chartLabel}>encaissé sur 30 jours</Text>
          </View>
          <View style={styles.todayBox}>
            <Text style={styles.todayValue}>{money(t.todayCents, t.currency)}</Text>
            <Text style={styles.chartLabel}>aujourd'hui</Text>
          </View>
        </View>
        <Chart values={daily.map((d) => d.cents)} width={chartWidth} height={120} baseline />
      </Card>

      <View style={styles.statRow}>
        <Card style={styles.statCard}>
          <Stat
            label="Ce mois"
            value={moneyCompact(t.mtdCents, t.currency)}
            hint={t.mtdVsPrevPct !== null ? `${percent(t.mtdVsPrevPct)} vs M-1` : 'premier mois'}
            hintColor={
              t.mtdVsPrevPct === null
                ? undefined
                : t.mtdVsPrevPct >= 0
                  ? colors.positive
                  : colors.negative
            }
          />
        </Card>
        <Card style={styles.statCard}>
          <Stat
            label="Depuis janvier"
            value={moneyCompact(t.ytdCents, t.currency)}
            hint={`${t.activeSubscribers} abonnés actifs`}
          />
        </Card>
      </View>

      <Card style={styles.projectionCard}>
        <View style={styles.projectionHead}>
          <Text style={styles.projectionLabel}>PROJECTION FIN {new Date().getFullYear()}</Text>
          <Text style={styles.projectionHint}>estimation</Text>
        </View>
        <Text style={styles.projectionValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {money(t.projection.projectedYearEndCents, t.currency)}
        </Text>
        <View style={styles.projectionBreak}>
          <View style={styles.projectionItem}>
            <Text style={styles.projectionItemValue}>{moneyCompact(t.projection.ytdCents, t.currency)}</Text>
            <Text style={styles.projectionItemLabel}>déjà encaissé</Text>
          </View>
          <View style={styles.projectionItem}>
            <Text style={styles.projectionItemValue}>
              {moneyCompact(t.projection.projectedRecurringCents, t.currency)}
            </Text>
            <Text style={styles.projectionItemLabel}>récurrent à venir</Text>
          </View>
          <View style={styles.projectionItem}>
            <Text style={styles.projectionItemValue}>
              {moneyCompact(t.projection.projectedOneOffCents, t.currency)}
            </Text>
            <Text style={styles.projectionItemLabel}>ponctuel estimé</Text>
          </View>
        </View>
      </Card>

      <SectionTitle>Mouvement du MRR</SectionTitle>
      <Card>
        <View style={styles.movementGrid}>
          <MovementCell label="Nouveaux" cents={movement.newMrrCents} currency={t.currency} tone="positive" />
          <MovementCell label="Expansion" cents={movement.expansionCents} currency={t.currency} tone="positive" />
          <MovementCell label="Contraction" cents={movement.contractionCents} currency={t.currency} tone="negative" />
          <MovementCell label="Churn" cents={movement.churnedCents} currency={t.currency} tone="negative" />
        </View>
        <View style={styles.netRow}>
          <Text style={styles.netLabel}>Net ce mois</Text>
          <Text
            style={[
              styles.netValue,
              { color: movement.netCents >= 0 ? colors.positive : colors.negative },
            ]}
          >
            {signed(movement.netCents, t.currency)}
          </Text>
        </View>
      </Card>

      <SectionTitle>6 derniers mois</SectionTitle>
      <Card>
        <Bars data={monthly} currency={t.currency} />
      </Card>

      <SectionTitle>Projets</SectionTitle>
      <View style={styles.projects}>
        {[...overview.projects]
          .sort((a, b) => b.mrrCents - a.mrrCents)
          .map((project) => (
            <ProjectCard
              key={project.projectId}
              metrics={project}
              share={project.mrrCents / totalMrr}
              onPress={() => router.push(`/project/${project.projectId}`)}
            />
          ))}
      </View>

      <SectionTitle action={{ label: 'Tout voir', onPress: () => router.push('/activity') }}>
        Dernière activité
      </SectionTitle>
      <Card padded={false} style={styles.feed}>
        {events.slice(0, 6).map((event) => (
          <EventRow
            key={event.id}
            event={event}
            currency={t.currency}
            flash={event.id === flashId}
            projectHasLogo={logoByProject.get(event.project_id) ?? false}
          />
        ))}
        {events.length === 0 && <EmptyState title="Aucun événement pour l'instant" />}
      </Card>
    </ScrollView>
  );
}

function MovementCell({
  label,
  cents,
  currency,
  tone,
}: {
  label: string;
  cents: number;
  currency: string;
  tone: 'positive' | 'negative';
}) {
  const active = cents !== 0;
  const tint = tone === 'positive' ? colors.positive : colors.negative;
  return (
    <View style={styles.movementCell}>
      <Text style={styles.movementLabel}>{label.toUpperCase()}</Text>
      <Text style={[styles.movementValue, { color: active ? tint : colors.textFaint }]}>
        {signed(cents, currency)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: space.lg, gap: 0 },

  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { ...type.caption, color: colors.textFaint, fontSize: 10 },
  projectCount: { ...type.body, color: colors.textDim, fontSize: 13, marginTop: 2 },

  hero: { marginTop: space.xl, marginBottom: space.xl },
  heroValue: { ...type.hero, ...type.tabular, color: colors.text },
  heroMeta: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 6, flexWrap: 'wrap' },
  heroLabel: { ...type.label, color: colors.textDim, fontSize: 12.5 },
  heroDelta: { ...type.label, ...type.tabular, fontSize: 12.5 },
  heroSep: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: colors.textFaint },

  goalCard: { marginBottom: space.md, borderColor: colors.border },
  chartCard: { gap: space.md },
  chartHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  chartValue: { ...type.title, ...type.tabular, color: colors.text, fontSize: 21 },
  chartLabel: { ...type.caption, color: colors.textFaint, fontSize: 10.5, marginTop: 1 },
  todayBox: { alignItems: 'flex-end' },
  todayValue: { ...type.title, ...type.tabular, color: colors.positive, fontSize: 21 },

  statRow: { flexDirection: 'row', gap: space.md, marginTop: space.md },
  statCard: { flex: 1 },

  projectionCard: { marginTop: space.md, gap: space.sm, borderColor: colors.border },
  projectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  projectionLabel: { ...type.caption, color: colors.accent, fontSize: 10 },
  projectionHint: { ...type.caption, color: colors.textFaint, fontSize: 9.5 },
  projectionValue: { ...type.title, ...type.tabular, color: colors.text, fontSize: 32 },
  projectionBreak: { flexDirection: 'row', gap: space.md, marginTop: 2 },
  projectionItem: { flex: 1, gap: 1 },
  projectionItemValue: { ...type.body, ...type.tabular, color: colors.textDim, fontSize: 13, fontWeight: '600' },
  projectionItemLabel: { ...type.caption, color: colors.textFaint, fontSize: 9.5 },

  movementGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space.lg },
  movementCell: { width: '50%', gap: 3 },
  movementLabel: { ...type.caption, color: colors.textFaint, fontSize: 9.5 },
  movementValue: { ...type.body, ...type.tabular, fontSize: 16, fontWeight: '700' },
  netRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.lg,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  netLabel: { ...type.label, color: colors.textDim },
  netValue: { ...type.title, ...type.tabular, fontSize: 19 },

  projects: { gap: space.md },
  feed: { paddingHorizontal: space.sm, paddingVertical: space.xs },
});
