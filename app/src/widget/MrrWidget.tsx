import React from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';
import { t } from '../i18n';

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
  /** Chiffres conservés d'une mise à jour antérieure, faute de réseau. */
  stale?: boolean;
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

/**
 * Densité d'information adaptée à la place disponible.
 *
 * En portrait, Android rapporte `OPTION_APPWIDGET_MAX_HEIGHT`, qui englobe les
 * marges du lanceur : la surface réellement dessinable est sensiblement plus
 * petite que la valeur annoncée. Les seuils intègrent donc une réserve
 * confortable. Surestimer la place tronque le contenu ; la sous-estimer donne
 * un widget aéré — le second défaut est bien moins gênant que le premier.
 */
function densityFor(width?: number, height?: number): Density {
  const h = height ?? 90;
  const w = width ?? 180;
  if (h < 110) return 'small';
  if (h < 175 || w < 170) return 'medium';
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
      <Shell padding={10}>
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
      <Shell padding={12}>
        <TextWidget
          text={t('widgetMrrLabel')}
          style={{ fontSize: 8, color: FAINT, fontWeight: '600', letterSpacing: 1 }}
        />
        <TextWidget
          text={data.mrr}
          style={{ fontSize: 24, color: TEXT, fontWeight: '700' }}
        />
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
          <TextWidget
            text={data.today}
            style={{ fontSize: 11, color: POSITIVE, fontWeight: '700' }}
          />
          <FlexWidget style={{ width: 5 }} />
          <TextWidget text={t('widgetTodayLower')} style={{ fontSize: 9, color: FAINT }} />
        </FlexWidget>
      </Shell>
    );
  }

  // `justifyContent: 'space-between'` étirait le contenu sur toute la hauteur
  // supposée : dès que la hauteur réelle était moindre, le bas se retrouvait
  // hors cadre. Un empilement naturel se contente de la place qu'il occupe.
  return (
    <Shell padding={14}>
      <TextWidget
        text={t('widgetMrrLabel')}
        style={{ fontSize: 9, color: FAINT, fontWeight: '600', letterSpacing: 1 }}
      />

      <TextWidget
        text={data.mrr}
        style={{ fontSize: 28, color: TEXT, fontWeight: '700', marginTop: 1 }}
      />

      {data.delta && (
        <TextWidget
          text={data.delta}
          style={{
            fontSize: 10,
            color: data.deltaPositive ? POSITIVE : NEGATIVE,
            fontWeight: '600',
          }}
        />
      )}

      <FlexWidget
        style={{
          flexDirection: 'row',
          marginTop: 8,
          paddingTop: 8,
          borderTopWidth: 1,
          borderTopColor: BORDER,
        }}
      >
        <FlexWidget style={{ flexDirection: 'column' }}>
          <TextWidget text={t('widgetToday')} style={{ fontSize: 8, color: FAINT, fontWeight: '600' }} />
          <TextWidget
            text={data.today}
            style={{ fontSize: 13, color: POSITIVE, fontWeight: '700' }}
          />
        </FlexWidget>

        <FlexWidget style={{ width: 18 }} />

        <FlexWidget style={{ flexDirection: 'column' }}>
          <TextWidget text={t('widgetThisMonth')} style={{ fontSize: 8, color: FAINT, fontWeight: '600' }} />
          <TextWidget text={data.mtd} style={{ fontSize: 13, color: DIM, fontWeight: '700' }} />
        </FlexWidget>

        <FlexWidget style={{ width: 12 }} />

        {/* Discret par construction : la fraîcheur se consulte, elle n'alerte pas. */}
        <TextWidget
          text={data.stale ? `${data.updatedAt} ·` : data.updatedAt}
          style={{ fontSize: 8, color: FAINT, marginTop: 10 }}
        />
      </FlexWidget>
    </Shell>
  );
}
