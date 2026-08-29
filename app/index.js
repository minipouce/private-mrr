/**
 * Point d'entrée de l'application.
 *
 * Le gestionnaire de widget doit être enregistré au chargement du bundle, y
 * compris lorsque Android réveille l'application sans interface pour rafraîchir
 * le widget — c'est pourquoi l'enregistrement précède le routeur.
 */
import { registerWidgetTaskHandler } from 'react-native-android-widget';
import { widgetTaskHandler } from './src/widget/handler';

registerWidgetTaskHandler(widgetTaskHandler);

import 'expo-router/entry';
