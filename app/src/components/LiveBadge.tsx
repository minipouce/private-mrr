import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { colors, radius, type } from '../theme/index';

type Status = 'loading' | 'live' | 'offline' | 'unconfigured' | 'error';

const LOOK: Record<Status, { tint: string; label: string }> = {
  live:         { tint: colors.positive, label: 'EN DIRECT' },
  loading:      { tint: colors.textDim,  label: 'CONNEXION' },
  offline:      { tint: colors.warning,  label: 'HORS LIGNE' },
  error:        { tint: colors.negative, label: 'ERREUR' },
  unconfigured: { tint: colors.textFaint, label: 'NON CONFIGURÉ' },
};

/** Pastille d'état du flux temps réel, avec pulsation quand la connexion est vivante. */
export function LiveBadge({ status }: { status: Status }) {
  const look = LOOK[status];
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (status !== 'live') {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1100,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [status, pulse]);

  return (
    <View style={styles.wrap}>
      <View style={styles.dotBox}>
        {status === 'live' && (
          <Animated.View
            style={[
              styles.halo,
              {
                backgroundColor: look.tint,
                opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
                transform: [
                  { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.8] }) },
                ],
              },
            ]}
          />
        )}
        <View style={[styles.dot, { backgroundColor: look.tint }]} />
      </View>
      <Text style={[styles.label, { color: look.tint }]}>{look.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  dotBox: { width: 7, height: 7, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  halo: { position: 'absolute', width: 7, height: 7, borderRadius: 3.5 },
  label: { ...type.caption, fontSize: 9.5, letterSpacing: 0.8 },
});
