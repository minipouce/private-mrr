import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, radius, space, type } from '../theme/index';
import { money } from '../lib/format';
import { t, plural } from '../i18n';

/**
 * MRR at risk: subscriptions that still count towards MRR while their payment
 * is failing.
 *
 * Stripe keeps retrying a `past_due` subscription and most of them come back,
 * so they stay inside the headline figure rather than making it drop and jump
 * back. But that is money not collected: without this strip it would be
 * indistinguishable from the rest of the MRR.
 *
 * Renders nothing when nothing is at risk, which is the normal case.
 */
export function AtRiskNote({
  cents,
  subscribers,
  currency,
  compact = false,
}: {
  cents: number;
  subscribers: number;
  currency: string;
  compact?: boolean;
}) {
  if (subscribers <= 0) return null;

  if (compact) {
    return (
      <Text style={styles.compact} numberOfLines={1}>
        {money(cents, currency)} {t('atRisk')}
      </Text>
    );
  }

  return (
    <View style={styles.strip}>
      <View style={styles.dot} />
      <Text style={styles.amount}>{money(cents, currency)}</Text>
      <Text style={styles.label}>{t('atRisk')}</Text>
      <Text style={styles.detail} numberOfLines={1}>
        {subscribers} {plural(subscribers, 'subscriber', 'subscribers')} · {t('paymentFailing')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginBottom: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.warningSoft,
    borderWidth: 1,
    borderColor: 'rgba(255, 176, 32, 0.22)',
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.warning },
  amount: { ...type.label, ...type.tabular, color: colors.warning },
  label: { ...type.caption, color: colors.warning, fontSize: 10.5 },
  // Pushed to the far end, and the first to shrink when the line is tight.
  detail: { ...type.caption, color: colors.textDim, fontSize: 10.5, flex: 1, textAlign: 'right' },
  compact: { ...type.caption, color: colors.warning, fontSize: 10.5 },
});
