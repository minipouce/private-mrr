import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Defs, LinearGradient, Stop, Circle, Line } from 'react-native-svg';
import { colors } from '../theme/index';

interface Props {
  values: number[];
  color?: string;
  height?: number;
  width: number;
  showDot?: boolean;
  /** Ligne horizontale de référence (moyenne, objectif…). */
  baseline?: boolean;
}

/**
 * Courbe d'aire lissée.
 *
 * Le lissage utilise des Bézier cubiques dont les points de contrôle sont
 * dérivés des voisins immédiats (Catmull-Rom). Le facteur 6 est volontairement
 * conservateur : au-delà, la courbe dépasse les valeurs réelles et laisse
 * croire à des pics qui n'existent pas.
 */
function buildPaths(values: number[], width: number, height: number, pad: number) {
  if (values.length < 2) return { line: '', area: '', last: { x: 0, y: 0 } };

  const min = Math.min(...values, 0);
  const max = Math.max(...values);
  const span = max - min || 1;

  const usable = height - pad * 2;
  const points = values.map((value, index) => ({
    x: (index / (values.length - 1)) * width,
    y: pad + usable - ((value - min) / span) * usable,
  }));

  let line = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;

    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;

    line += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }

  const area = `${line} L ${width} ${height} L 0 ${height} Z`;
  return { line, area, last: points[points.length - 1]! };
}

export function Chart({
  values,
  color = colors.accent,
  height = 130,
  width,
  showDot = true,
  baseline = false,
}: Props) {
  const pad = 10;
  const { line, area, last } = useMemo(
    () => buildPaths(values, width, height, pad),
    [values, width, height],
  );

  if (!line) return <View style={{ height }} />;

  const gradientId = `grad-${color.replace('#', '')}`;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values, 0);
  const max = Math.max(...values);
  const meanY = pad + (height - pad * 2) - ((mean - min) / (max - min || 1)) * (height - pad * 2);

  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={0.32} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </LinearGradient>
      </Defs>

      {baseline && (
        <Line
          x1={0}
          y1={meanY}
          x2={width}
          y2={meanY}
          stroke={colors.border}
          strokeWidth={1}
          strokeDasharray="3 5"
        />
      )}

      <Path d={area} fill={`url(#${gradientId})`} />
      <Path
        d={line}
        stroke={color}
        strokeWidth={2.4}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {showDot && (
        <>
          <Circle cx={last.x} cy={last.y} r={7} fill={color} opacity={0.22} />
          <Circle cx={last.x} cy={last.y} r={3.5} fill={color} />
        </>
      )}
    </Svg>
  );
}
