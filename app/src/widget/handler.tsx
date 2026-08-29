import React from 'react';
import type { WidgetTaskHandlerProps } from 'react-native-android-widget';
import { MrrWidget } from './MrrWidget';
import { loadWidgetData } from './data';

/**
 * Gestionnaire de tâche du widget.
 *
 * Exécuté hors de l'application, dans un contexte JavaScript sans interface :
 * ni état React partagé, ni navigation. Il relit donc la configuration et
 * interroge l'API lui-même à chaque réveil.
 */
const NAME = 'Mrr';

export async function widgetTaskHandler(props: WidgetTaskHandlerProps) {
  if (props.widgetInfo.widgetName !== NAME) return;

  switch (props.widgetAction) {
    case 'WIDGET_ADDED':
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED':
    case 'WIDGET_CLICK':
      props.renderWidget(
        <MrrWidget
          data={await loadWidgetData()}
          width={props.widgetInfo.width}
          height={props.widgetInfo.height}
        />,
      );
      break;
    default:
      break;
  }
}
