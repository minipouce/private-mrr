import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Pressable } from 'react-native';
import { colors, radius, space, type } from '../theme/index';
import { moneyPrecise, signed, timeAgo, customerLabel } from '../lib/format';
import type { EventKind, RevenueEvent } from '../api/types';
import { ProjectLogo } from './ProjectLogo';
import { t } from '../i18n';

const PRESENTATION: Record<
  EventKind,
  { glyph: string; tint: string; soft: string; label: keyof typeof import('../i18n/strings').en }
> = {
  payment:               { glyph: '↑', tint: colors.positive, soft: colors.positiveSoft, label: 'eventPayment' },
  refund:                { glyph: '↩', tint: colors.warning,  soft: colors.warningSoft,  label: 'eventRefund' },
  payment_failed:        { glyph: '!', tint: colors.negative, soft: colors.negativeSoft, label: 'eventFailed' },
  subscription_created:  { glyph: '✦', tint: colors.accent,   soft: colors.accentSoft,   label: 'eventNewSubscriber' },
  subscription_updated:  { glyph: '⇅', tint: colors.accent,   soft: colors.accentSoft,   label: 'eventChange' },
  subscription_canceled: { glyph: '×', tint: colors.negative, soft: colors.negativeSoft, label: 'eventCancellation' },
  trial_started:         { glyph: '◷', tint: colors.textDim,  soft: colors.surfaceHi,    label: 'eventTrial' },
};

interface Props {
  event: RevenueEvent;
  currency?: string;
  /** Triggers a brief halo when the event has just arrived live. */
  flash?: boolean;
  onPress?: () => void;
  showProject?: boolean;
  /** Supplied by the calling screen, which holds the consolidated overview. */
  projectHasLogo?: boolean;
}

export function EventRow({
  event,
  currency = 'eur',
  flash = false,
  onPress,
  showProject = true,
  projectHasLogo = false,
}: Props) {
  const look = PRESENTATION[event.kind];
  const glow = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!flash) return;
    // A near-instant rise then a slow fade: the eye catches the arrival without
    // the row staying highlighted forever.
    Animated.sequence([
      Animated.timing(glow, { toValue: 1, duration: 180, useNativeDriver: false }),
      Animated.timing(glow, { toValue: 0, duration: 1400, useNativeDriver: false }),
    ]).start();
  }, [flash, glow]);

  const background = glow.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(0,0,0,0)', look.soft],
  });

  // Subscription movements read as MRR, payments read as an amount.
  const isMrrMove =
    event.kind === 'subscription_created' ||
    event.kind === 'subscription_updated' ||
    event.kind === 'subscription_canceled';

  const amount = isMrrMove
    ? signed(event.mrr_delta_cents, currency)
    : moneyPrecise(event.amount_base_cents, currency);

  const amountColor = isMrrMove
    ? event.mrr_delta_cents >= 0
      ? colors.positive
      : colors.negative
    : event.kind === 'payment'
      ? colors.text
      : look.tint;

  return (
    <Animated.View style={[styles.row, { backgroundColor: background }]}>
      <Pressable style={styles.pressable} onPress={onPress} disabled={!onPress}>
        <View style={[styles.glyphBox, { backgroundColor: look.soft }]}>
          <Text style={[styles.glyph, { color: look.tint }]}>{look.glyph}</Text>
        </View>

        <View style={styles.middle}>
          <Text style={styles.who} numberOfLines={1}>
            {customerLabel(event.customer_name, event.customer_email)}
          </Text>
          <View style={styles.metaRow}>
            {showProject && (
              <>
                <ProjectLogo
                  projectId={event.project_id}
                  color={event.project_color}
                  hasLogo={projectHasLogo}
                  size={14}
                />
                <Text style={styles.meta} numberOfLines={1}>
                  {event.project_name}
                </Text>
                <Text style={styles.metaSep}>·</Text>
              </>
            )}
            <Text style={styles.meta} numberOfLines={1}>
              {t(look.label)}
            </Text>
          </View>
        </View>

        <View style={styles.right}>
          <Text style={[styles.amount, { color: amountColor }]} numberOfLines={1}>
            {amount}
          </Text>
          <Text style={styles.time}>{timeAgo(event.occurred_at)}</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { borderRadius: radius.md },
  pressable: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 11,
    paddingHorizontal: space.sm,
  },
  glyphBox: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { fontSize: 15, fontWeight: '700' },
  middle: { flex: 1, gap: 2 },
  who: { ...type.body, color: colors.text, fontSize: 14.5 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  meta: { ...type.caption, color: colors.textFaint, fontSize: 11, fontWeight: '500' },
  metaSep: { color: colors.textFaint, fontSize: 11 },
  right: { alignItems: 'flex-end', gap: 2 },
  amount: { ...type.body, ...type.tabular, fontSize: 14.5, fontWeight: '700' },
  time: { ...type.caption, color: colors.textFaint, fontSize: 10.5, fontWeight: '500' },
});
