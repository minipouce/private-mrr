import { Platform } from 'react-native';

/**
 * Redraws the widget with fresh data.
 *
 * Android's automatic cycle is capped at one update every 30 minutes. Without
 * this trigger, a widget looked at right after a payment would still show the
 * previous state.
 *
 * The render must produce the real values: `requestWidgetUpdate` literally
 * draws what it is given, it does not invalidate a cache.
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
      // With no widget placed on the home screen, there is nothing to update.
      widgetNotFound: () => undefined,
    });
  } catch {
    // Refreshing the widget must never disrupt the application.
  }
}
