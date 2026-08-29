import React from 'react';
import type { WidgetTaskHandlerProps } from 'react-native-android-widget';
import { MrrWidget } from './MrrWidget';
import { loadWidgetData } from './data';

/**
 * Widget task handler.
 *
 * Runs outside the application, in a headless JavaScript context: no shared
 * React state, no navigation. It therefore re-reads the configuration and
 * queries the API itself on every wake-up.
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
