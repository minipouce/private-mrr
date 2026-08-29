import React, { useState } from 'react';
import { View, Image, StyleSheet, type ViewStyle } from 'react-native';
import { peekConfig } from '../api/config';
import { colors, radius } from '../theme';

/**
 * Logo d'un projet, avec repli sur une pastille de couleur.
 *
 * The logo endpoint is public, because Firebase must be able to load the same
 * image for notifications, so no authentication header is needed here. If
 * loading fails, this falls back silently to the badge rather than showing a
 * broken image.
 */
export function ProjectLogo({
  projectId,
  color,
  hasLogo = false,
  size = 22,
  style,
}: {
  projectId: string | null;
  color: string;
  hasLogo?: boolean;
  size?: number;
  style?: ViewStyle;
}) {
  const [failed, setFailed] = useState(false);
  const config = peekConfig();

  const showImage = hasLogo && projectId && config && !failed;

  if (!showImage) {
    // The badge keeps the same visual footprint as the logo, so the layout does
    // not shift depending on whether a project has one.
    return (
      <View
        style={[
          styles.dot,
          { width: size * 0.42, height: size * 0.42, borderRadius: size, backgroundColor: color },
          { marginHorizontal: size * 0.29 },
          style,
        ]}
      />
    );
  }

  return (
    <View
      style={[
        styles.frame,
        { width: size, height: size, borderRadius: Math.max(radius.sm * (size / 34), 5) },
        style,
      ]}
    >
      <Image
        source={{ uri: `${config!.baseUrl}/logos/${projectId}` }}
        style={styles.image}
        resizeMode="contain"
        onError={() => setFailed(true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {},
  frame: {
    overflow: 'hidden',
    backgroundColor: colors.surfaceHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { width: '100%', height: '100%' },
});
