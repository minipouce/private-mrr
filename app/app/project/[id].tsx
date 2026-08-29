import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator,
  useWindowDimensions, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { useLive } from '../../src/hooks/useLive';
import { api } from '../../src/api/client';
import { colors, radius, space, type } from '../../src/theme/index';
import { money, moneyCompact, percent, signed, customerLabel } from '../../src/lib/format';
import { Chart } from '../../src/components/Chart';
import { Bars } from '../../src/components/Bars';
import { EventRow } from '../../src/components/EventRow';
import { Card, SectionTitle, Stat, EmptyState, Divider } from '../../src/components/ui';
import { ProjectLogo } from '../../src/components/ProjectLogo';
import { GoalBar } from '../../src/components/GoalBar';
import type { DailyPoint, MonthlyPoint, Metrics, Subscriber } from '../../src/api/types';
import { t, plural } from '../../src/i18n';

export default function ProjectDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { overview, events, flashId } = useLive();

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [daily, setDaily] = useState<DailyPoint[]>([]);
  const [monthly, setMonthly] = useState<MonthlyPoint[]>([]);
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [m, d, mo, subs] = await Promise.all([
        api.project(id),
        api.daily(30, id),
        api.monthly(6, id),
        api.subscribers(id, 8),
      ]);
      setMetrics(m);
      setDaily(d.series);
      setMonthly(mo.series);
      setSubscribers(subs.subscribers);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Le flux temps réel rafraîchit l'agrégat global ; on resynchronise le détail
  // du projet dans la foulée pour éviter deux chiffres divergents à l'écran.
  useEffect(() => {
    if (overview) void load();
  }, [overview?.generatedAt, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const projectEvents = events.filter((event) => event.project_id === id);
  // L'aperçu consolidé porte l'indicateur de logo ; le détail ne le renvoie pas.
  const projectHasLogo = overview?.projects.find((p) => p.projectId === id)?.hasLogo ?? false;
  const projectGoal = overview?.projects.find((p) => p.projectId === id)?.goal ?? null;
  const chartWidth = width - space.lg * 2 - space.lg * 2;

  if (!metrics) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        {error ? <EmptyState title={error} /> : <ActivityIndicator color={colors.accent} />}
      </View>
    );
  }

  const movement = metrics.movement;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + space.sm, paddingBottom: space.xxl },
      ]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.nav}>
        <Pressable onPress={() => router.back()} hitSlop={14} style={styles.back}>
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <View style={styles.navTitle}>
          <ProjectLogo
            projectId={metrics.projectId}
            color={metrics.color}
            hasLogo={projectHasLogo}
            size={26}
          />
          <Text style={styles.navText} numberOfLines={1}>
            {metrics.name}
          </Text>
        </View>
      </View>

      <View style={styles.hero}>
        <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
          {money(metrics.mrrCents, metrics.currency)}
        </Text>
        <View style={styles.heroMeta}>
          <Text style={styles.heroLabel}>MRR</Text>
          <View style={styles.heroSep} />
          <Text style={styles.heroLabel}>{money(metrics.arrCents, metrics.currency)} ARR</Text>
          <View style={styles.heroSep} />
          <Text style={styles.heroLabel}>
            {metrics.activeSubscribers}{' '}
            {plural(metrics.activeSubscribers, 'subscriber', 'subscribers')}
            {metrics.trials > 0 ? ` · ${metrics.trials} ${t('onTrial')}` : ''}
          </Text>
        </View>
      </View>

      {projectGoal && (
        <Card style={{ marginBottom: space.md, borderColor: colors.border }}>
          <GoalBar goal={projectGoal} color={metrics.color} currency={metrics.currency} />
        </Card>
      )}

      <Card style={styles.chartCard}>
        <View style={styles.chartHead}>
          <View>
            <Text style={styles.chartValue}>{money(metrics.last30Cents, metrics.currency)}</Text>
            <Text style={styles.chartLabel}>{t('collectedOver30Days')}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[styles.chartValue, { color: colors.positive }]}>
              {money(metrics.todayCents, metrics.currency)}
            </Text>
            <Text style={styles.chartLabel}>{t('today')}</Text>
          </View>
        </View>
        <Chart values={daily.map((d) => d.cents)} width={chartWidth} height={116} color={metrics.color} baseline />
      </Card>

      <View style={styles.statRow}>
        <Card style={{ flex: 1 }}>
          <Stat
            label={t('thisMonth')}
            value={moneyCompact(metrics.mtdCents, metrics.currency)}
            hint={metrics.mtdVsPrevPct !== null ? `${percent(metrics.mtdVsPrevPct)} ${t('vsPrevMonth')}` : undefined}
            hintColor={
              metrics.mtdVsPrevPct === null
                ? undefined
                : metrics.mtdVsPrevPct >= 0
                  ? colors.positive
                  : colors.negative
            }
          />
        </Card>
        <Card style={{ flex: 1 }}>
          <Stat label={t('sinceJanuary')} value={moneyCompact(metrics.ytdCents, metrics.currency)} />
        </Card>
      </View>

      <Card style={styles.projectionCard}>
        <Text style={styles.projectionLabel}>{t('projectionEndOf')} {new Date().getFullYear()}</Text>
        <Text style={styles.projectionValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {money(metrics.projection.projectedYearEndCents, metrics.currency)}
        </Text>
        <Text style={styles.projectionHint}>
          {t('ofWhichCollected')} {moneyCompact(metrics.projection.ytdCents, metrics.currency)} ·{' '}
          {t('runRate')} {moneyCompact(metrics.projection.runRateCents, metrics.currency)}
        </Text>
      </Card>

      <SectionTitle>{t('mrrMovementThisMonth')}</SectionTitle>
      <Card>
        <MovementLine label={t('newCustomers')} cents={movement.newMrrCents} currency={metrics.currency} />
        <Divider />
        <MovementLine label={t('expansion')} cents={movement.expansionCents} currency={metrics.currency} />
        <Divider />
        <MovementLine label={t('contraction')} cents={movement.contractionCents} currency={metrics.currency} />
        <Divider />
        <MovementLine label={t('churn')} cents={movement.churnedCents} currency={metrics.currency} />
        <View style={styles.netRow}>
          <Text style={styles.netLabel}>{t('net')}</Text>
          <Text
            style={[
              styles.netValue,
              { color: movement.netCents >= 0 ? colors.positive : colors.negative },
            ]}
          >
            {signed(movement.netCents, metrics.currency)}
          </Text>
        </View>
      </Card>

      <SectionTitle>{t('lastSixMonths')}</SectionTitle>
      <Card>
        <Bars data={monthly} color={metrics.color} currency={metrics.currency} />
      </Card>

      {subscribers.length > 0 && (
        <>
          <SectionTitle>{t('topSubscribers')}</SectionTitle>
          <Card padded={false} style={styles.list}>
            {subscribers.map((sub, index) => (
              <View key={sub.id}>
                {index > 0 && <View style={styles.sep} />}
                <View style={styles.subRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.subName} numberOfLines={1}>
                      {customerLabel(sub.customer_name, sub.customer_email)}
                    </Text>
                    <Text style={styles.subMeta} numberOfLines={1}>
                      {sub.product_name ?? '—'}
                      {sub.status === 'trialing' ? ` · ${t('trialLabel')}` : ''}
                      {sub.status === 'past_due' ? ` · ${t('pastDueLabel')}` : ''}
                    </Text>
                  </View>
                  <Text style={styles.subAmount}>
                    {money(sub.mrr_base_cents, metrics.currency)}
                  </Text>
                </View>
              </View>
            ))}
          </Card>
        </>
      )}

      <SectionTitle>{t('recentActivity')}</SectionTitle>
      <Card padded={false} style={styles.feed}>
        {projectEvents.slice(0, 15).map((event) => (
          <EventRow
            key={event.id}
            event={event}
            currency={metrics.currency}
            flash={event.id === flashId}
            showProject={false}
          />
        ))}
        {projectEvents.length === 0 && <EmptyState title={t('noRecentEvents')} />}
      </Card>
    </ScrollView>
  );
}

function MovementLine({
  label,
  cents,
  currency,
}: {
  label: string;
  cents: number;
  currency: string;
}) {
  return (
    <View style={styles.movementRow}>
      <Text style={styles.movementLabel}>{label}</Text>
      <Text
        style={[
          styles.movementValue,
          { color: cents === 0 ? colors.textFaint : cents > 0 ? colors.positive : colors.negative },
        ]}
      >
        {signed(cents, currency)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: space.lg },

  nav: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.lg },
  back: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  backGlyph: { color: colors.text, fontSize: 30, lineHeight: 32, marginTop: -4 },
  navTitle: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
  navText: { ...type.heading, color: colors.text, flex: 1 },

  hero: { marginBottom: space.lg },
  heroValue: { ...type.hero, ...type.tabular, color: colors.text, fontSize: 40 },
  heroMeta: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 5, flexWrap: 'wrap' },
  heroLabel: { ...type.label, color: colors.textDim, fontSize: 12 },
  heroSep: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: colors.textFaint },

  chartCard: { gap: space.md },
  chartHead: { flexDirection: 'row', justifyContent: 'space-between' },
  chartValue: { ...type.title, ...type.tabular, color: colors.text, fontSize: 20 },
  chartLabel: { ...type.caption, color: colors.textFaint, fontSize: 10.5, marginTop: 1 },

  statRow: { flexDirection: 'row', gap: space.md, marginTop: space.md },

  projectionCard: { marginTop: space.md, gap: 4, borderColor: colors.border },
  projectionLabel: { ...type.caption, color: colors.accent, fontSize: 10 },
  projectionValue: { ...type.title, ...type.tabular, color: colors.text, fontSize: 29 },
  projectionHint: { ...type.caption, color: colors.textFaint, fontSize: 10.5, lineHeight: 16 },

  movementRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  movementLabel: { ...type.body, color: colors.textDim, fontSize: 14 },
  movementValue: { ...type.body, ...type.tabular, fontSize: 14.5, fontWeight: '700' },
  netRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  netLabel: { ...type.label, color: colors.text },
  netValue: { ...type.title, ...type.tabular, fontSize: 18 },

  list: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  sep: { height: 1, backgroundColor: colors.borderSoft },
  subRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, gap: space.md },
  subName: { ...type.body, color: colors.text, fontSize: 14 },
  subMeta: { ...type.caption, color: colors.textFaint, fontSize: 10.5, marginTop: 2 },
  subAmount: { ...type.body, ...type.tabular, color: colors.text, fontSize: 14, fontWeight: '700' },

  feed: { paddingHorizontal: space.sm, paddingVertical: space.xs },
});
