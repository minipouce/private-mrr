import React from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';

/**
 * Widget d'écran d'accueil, adaptatif.
 *
 * Rendu en RemoteViews Android : ni styles React Native, ni jetons de thème n'y
 * sont résolus, d'où une composition plate et des couleurs littérales.
 *
 * Android communique la taille réelle en dp à chaque redimensionnement ; on
 * décline trois densités d'information plutôt que de comprimer une mise en page
 * unique jusqu'à l'illisible.
 */

export interface WidgetData {
  mrr: string;
  today: string;
  mtd: string;
  delta: string | null;
  deltaPositive: boolean;
  updatedAt: string;
  error?: string;
}

const BG = '#0E1016';
const BORDER = '#232838';
const TEXT = '#F2F4F8';
const DIM = '#9AA1B4';
const FAINT = '#5C6379';
const POSITIVE = '#22D39A';
const NEGATIVE = '#FF5C7A';

type Density = 'small' | 'medium' | 'large';

/** Deux seuils suffisent : la hauteur décide, la largeur n'ajoute que du confort. */
function densityFor(width?: number, height?: number): Density {
  const h = height ?? 110;
  const w = width ?? 180;
  if (h < 80) return 'small';
  if (h < 130 || w < 150) return 'medium';
  return 'large';
}

function Shell({ children, padding }: { children: React.ReactNode; padding: number }) {
  return (
    <FlexWidget
      clickAction="OPEN_APP"
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: BG,
        borderRadius: 24,
        padding,
        flexDirection: 'column',
        justifyContent: 'center',
      }}
    >
      {children}
    </FlexWidget>
  );
}

export function MrrWidget({
  data,
  width,
  height,
}: {
  data: WidgetData;
  width?: number;
  height?: number;
}) {
  const density = densityFor(width, height);

  if (data.error) {
    return (
      <Shell padding={12}>
        <TextWidget text="MRR" style={{ fontSize: 10, color: FAINT, fontWeight: '600' }} />
        <TextWidget text={data.error} style={{ fontSize: 12, color: DIM, marginTop: 4 }} />
      </Shell>
    );
  }

  // Format le plus dense : le seul chiffre qui compte, en grand.
  if (density === 'small') {
    return (
      <Shell padding={12}>
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TextWidget text={data.mrr} style={{ fontSize: 22, color: TEXT, fontWeight: '700' }} />
          <FlexWidget style={{ width: 8 }} />
          <TextWidget
            text="MRR"
            style={{ fontSize: 9, color: FAINT, fontWeight: '600' }}
          />
        </FlexWidget>
        {data.delta && (
          <TextWidget
            text={data.delta}
            style={{
              fontSize: 9,
              color: data.deltaPositive ? POSITIVE : NEGATIVE,
              fontWeight: '600',
              marginTop: 2,
            }}
          />
        )}
      </Shell>
    );
  }

  if (density === 'medium') {
    return (
      <Shell padding={14}>
        <TextWidget
          text="MRR CONSOLIDÉ"
          style={{ fontSize: 8, color: FAINT, fontWeight: '600', letterSpacing: 1 }}
        />
        <TextWidget
          text={data.mrr}
          style={{ fontSize: 26, color: TEXT, fontWeight: '700', marginTop: 2 }}
        />
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
          <TextWidget
            text={data.today}
            style={{ fontSize: 12, color: POSITIVE, fontWeight: '700' }}
          />
          <FlexWidget style={{ width: 6 }} />
          <TextWidget text="aujourd'hui" style={{ fontSize: 9, color: FAINT }} />
        </FlexWidget>
      </Shell>
    );
  }

  return (
    <FlexWidget
      clickAction="OPEN_APP"
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: BG,
        borderRadius: 24,
        padding: 16,
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      <TextWidget
        text="MRR CONSOLIDÉ"
        style={{ fontSize: 9, color: FAINT, fontWeight: '600', letterSpacing: 1 }}
      />

      <FlexWidget style={{ flexDirection: 'column' }}>
        <TextWidget text={data.mrr} style={{ fontSize: 30, color: TEXT, fontWeight: '700' }} />
        {data.delta && (
          <TextWidget
            text={data.delta}
            style={{
              fontSize: 11,
              color: data.deltaPositive ? POSITIVE : NEGATIVE,
              fontWeight: '600',
              marginTop: 1,
            }}
          />
        )}
      </FlexWidget>

      <FlexWidget
        style={{
          flexDirection: 'row',
          marginTop: 10,
          paddingTop: 10,
          borderTopWidth: 1,
          borderTopColor: BORDER,
        }}
      >
        <FlexWidget style={{ flexDirection: 'column' }}>
          <TextWidget text="AUJOURD'HUI" style={{ fontSize: 8, color: FAINT, fontWeight: '600' }} />
          <TextWidget
            text={data.today}
            style={{ fontSize: 14, color: POSITIVE, fontWeight: '700' }}
          />
        </FlexWidget>

        <FlexWidget style={{ width: 18 }} />

        <FlexWidget style={{ flexDirection: 'column' }}>
          <TextWidget text="CE MOIS" style={{ fontSize: 8, color: FAINT, fontWeight: '600' }} />
          <TextWidget text={data.mtd} style={{ fontSize: 14, color: DIM, fontWeight: '700' }} />
        </FlexWidget>
      </FlexWidget>

      <TextWidget text={data.updatedAt} style={{ fontSize: 8, color: FAINT, marginTop: 6 }} />
    </FlexWidget>
  );
}
