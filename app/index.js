/**
 * Application entry point.
 *
 * The widget task handler must be registered when the bundle loads, including
 * when Android wakes the application headless to refresh the widget. That is
 * why registration comes before the router.
 */
import { registerWidgetTaskHandler } from 'react-native-android-widget';
import { widgetTaskHandler } from './src/widget/handler';

registerWidgetTaskHandler(widgetTaskHandler);

import 'expo-router/entry';
