import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, RefreshControl, Pressable, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLive } from '../../src/hooks/useLive';
import { api } from '../../src/api/client';
import { colors, radius, space, type } from '../../src/theme/index';
import { EventRow } from '../../src/components/EventRow';
import { LiveBadge } from '../../src/components/LiveBadge';
import { EmptyState } from '../../src/components/ui';
import type { EventKind, RevenueEvent } from '../../src/api/types';
import { t } from '../../src/i18n';

const FILTERS: { id: string; label: keyof typeof import('../../src/i18n/strings').en; kinds?: EventKind[] }[] = [
  { id: 'all', label: 'filterAll' as const },
  { id: 'cash', label: 'filterPayments' as const, kinds: ['payment'] },
  { id: 'new', label: 'filterNew' as const, kinds: ['subscription_created', 'trial_started'] },
  { id: 'churn', label: 'filterCancellations' as const, kinds: ['subscription_canceled'] },
  { id: 'issues', label: 'filterIssues' as const, kinds: ['payment_failed', 'refund'] },
];

export default function Activity() {
  const { events, status, flashId, overview, refresh } = useLive();
  const insets = useSafeAreaInsets();

  const [filter, setFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const [older, setOlder] = useState<RevenueEvent[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const currency = overview?.currency ?? 'eur';
  const logoByProject = useMemo(
    () => new Map((overview?.projects ?? []).map((p) => [p.projectId ?? '', p.hasLogo ?? false])),
    [overview],
  );

  // Le flux direct et les pages chargées à la demande sont fusionnés puis
  // dédupliqués : un même événement peut apparaître dans les deux sources.
  const combined = useMemo(() => {
    const seen = new Set<number>();
    return [...events, ...older].filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
  }, [events, older]);

  const visible = useMemo(() => {
    const active = FILTERS.find((f) => f.id === filter);
    if (!active?.kinds) return combined;
    return combined.filter((event) => active.kinds!.includes(event.kind));
  }, [combined, filter]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setOlder([]);
    setExhausted(false);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (loadingMore || exhausted || combined.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = combined[combined.length - 1]!;
      const page = await api.events({ before: oldest.id, limit: 50 });
      if (page.events.length === 0) setExhausted(true);
      else setOlder((prev) => [...prev, ...page.events]);
    } catch {
      setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  }, [combined, loadingMore, exhausted]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space.md }]}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('activity')}</Text>
        <LiveBadge status={status} />
      </View>

      <View style={styles.filters}>
        {FILTERS.map((item) => {
          const active = item.id === filter;
          return (
            <Pressable
              key={item.id}
              onPress={() => setFilter(item.id)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{t(item.label)}</Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        data={visible}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <EventRow
            event={item}
            currency={currency}
            flash={item.id === flashId}
            projectHasLogo={logoByProject.get(item.project_id) ?? false}
          />
        )}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        ListEmptyComponent={
          <EmptyState
            title={t('noEvents')}
            hint={filter === 'all' ? undefined : t('tryAnotherFilter')}
          />
        }
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator color={colors.accent} style={{ marginVertical: space.lg }} />
          ) : exhausted && visible.length > 0 ? (
            <Text style={styles.end}>{t('endOfHistory')}</Text>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: space.lg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.lg,
  },
  title: { ...type.title, color: colors.text },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md },
  chip: {
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  chipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipText: { ...type.caption, color: colors.textDim, fontSize: 11.5 },
  chipTextActive: { color: colors.accent },
  list: { paddingBottom: space.xxl },
  end: {
    ...type.caption,
    color: colors.textFaint,
    textAlign: 'center',
    marginVertical: space.lg,
  },
});
