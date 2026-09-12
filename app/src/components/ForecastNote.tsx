import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, space, type } from '../theme/index';
import { moneyRounded, percent } from '../lib/format';
import type { Projection } from '../api/types';
import { t } from '../i18n';

/** Minimum months of history the server needs before it extrapolates anything. */
const MIN_HISTORY = 3;

/**
 * The range around a projection, and the drivers it was built on.
 *
 * A single number would read as a promise. What the forecast actually knows is
 * a churn rate, a typical month of sales and a billing schedule — so it shows
 * them, along with the spread between "nobody else ever signs up" and "the
 * trend holds".
 */
export function ForecastRange({
  projection,
  currency,
}: {
  projection: Projection;
  currency: string;
}) {
  const { drivers } = projection;
  if (drivers.monthsObserved < MIN_HISTORY) {
    return <Text style={styles.thin}>{t('thinHistory')}</Text>;
  }

  return (
    <Text style={styles.range} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
      <Text style={styles.rangeLabel}>{t('conservative')} </Text>
      {moneyRounded(projection.lowCents, currency)}
      <Text style={styles.rangeLabel}>{'   ·   '}{t('optimistic')} </Text>
      {moneyRounded(projection.highCents, currency)}
    </Text>
  );
}

/** One line naming what the projection assumes, and where churn is heading. */
export function ForecastDriversLine({
  projection,
  currency,
}: {
  projection: Projection;
  currency: string;
}) {
  const { drivers } = projection;
  if (drivers.monthsObserved < MIN_HISTORY) return null;

  // A rising churn is bad news, so the arrow is tinted by meaning, not by sign.
  const arrow = drivers.churnTrendPct > 0.5 ? '↑' : drivers.churnTrendPct < -0.5 ? '↓' : '';
  const arrowColor = drivers.churnTrendPct > 0.5 ? colors.negative : colors.positive;

  return (
    <View style={styles.drivers}>
      <Text style={styles.driversText} numberOfLines={2}>
        <Text style={styles.driversStrong}>{percent(drivers.churnRate * 100)}</Text>
        {' '}{t('churnPerMonth')}{' '}
        {arrow ? <Text style={{ color: arrowColor }}>{arrow}</Text> : null}
        {drivers.churnBorrowed ? ` (${t('allProjects')})` : ''}
        {'  ·  '}
        <Text style={styles.driversStrong}>
          +{moneyRounded(drivers.newBusinessCents, currency)}
        </Text>
        {' '}{t('newPerMonth')}
        {'  ·  '}
        {t('measuredOver', {
          count: drivers.churnMonthsObserved,
          events: drivers.churnLossEvents,
        })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  range: {
    ...type.label,
    ...type.tabular,
    color: colors.textDim,
    marginTop: space.xs,
  },
  rangeLabel: { ...type.caption, color: colors.textFaint, fontSize: 10.5 },
  drivers: {
    marginTop: space.md,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  driversText: { ...type.caption, color: colors.textFaint, fontSize: 10.5, lineHeight: 15 },
  driversStrong: { color: colors.textDim },
  thin: { ...type.caption, color: colors.textFaint, fontSize: 10.5, marginTop: space.xs },
});
