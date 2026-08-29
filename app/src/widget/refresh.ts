import { Platform } from 'react-native';

/**
 * Redessine le widget avec des données fraîches.
 *
 * Le cycle automatique d'Android est plafonné à une mise à jour toutes les
 * 30 minutes. Sans ce déclenchement, un widget consulté juste après un paiement
 * afficherait encore l'état d'avant.
 *
 * Le rendu doit produire les vraies valeurs : `requestWidgetUpdate` dessine
 * littéralement ce qu'on lui passe, il n'invalide pas un cache.
 */
export async function refreshWidget(): Promise<void> {
  if (Platform.OS !== 'android') return;

  try {
    const [{ requestWidgetUpdate }, { MrrWidget }, { loadWidgetData }, React] = await Promise.all([
      import('react-native-android-widget'),
      import('./MrrWidget'),
      import('./data'),
      import('react'),
    ]);

    const data = await loadWidgetData();

    await requestWidgetUpdate({
      widgetName: 'Mrr',
      renderWidget: (info) =>
        React.createElement(MrrWidget, { data, width: info?.width, height: info?.height }),
      // Sans widget posé sur l'écran d'accueil, il n'y a rien à mettre à jour.
      widgetNotFound: () => undefined,
    });
  } catch {
    // Le rafraîchissement du widget ne doit jamais perturber l'application.
  }
}
