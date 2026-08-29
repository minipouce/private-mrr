import React, { useState } from 'react';
import { View, Image, StyleSheet, type ViewStyle } from 'react-native';
import { peekConfig } from '../api/config';
import { colors, radius } from '../theme';

/**
 * Logo d'un projet, avec repli sur une pastille de couleur.
 *
 * L'endpoint des logos est public — Firebase doit pouvoir charger la même image
 * pour les notifications — donc aucun en-tête d'authentification n'est requis
 * ici. En cas d'échec de chargement, on retombe silencieusement sur la pastille
 * plutôt que d'afficher une image cassée.
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
    // Pastille : même empreinte visuelle que le logo, pour que rien ne bouge
    // dans la mise en page selon qu'un projet en ait un ou non.
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
