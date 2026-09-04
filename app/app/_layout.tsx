import React, { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { LiveProvider } from '../src/hooks/useLive';
import { ensureChannels, usePush } from '../src/hooks/usePush';
import { onLanguageChange } from '../src/i18n';
import { refreshWidget } from '../src/widget/refresh';
import { colors } from '../src/theme/index';

export default function RootLayout() {
  // The channels must exist before any notification, whatever screen is shown
  // and whether or not the device is already registered.
  useEffect(() => {
    void ensureChannels();
  }, []);

  // Mounted here so the token sync runs at launch on every screen. The hook
  // was previously mounted only by the settings screen, which meant the server
  // never heard from the app unless that screen was opened.
  usePush();

  /**
   * Remounts the screens when the language changes.
   *
   * `t()` is read during render, so a re-render is enough to pick up the new
   * strings, but a screen holding state would not re-render on its own. Keying
   * the stack forces it. `LiveProvider` deliberately sits outside: remounting it
   * would drop the SSE connection and reload every figure for a label change.
   */
  const [languageKey, setLanguageKey] = useState(0);
  useEffect(
    () =>
      onLanguageChange(() => {
        setLanguageKey((n) => n + 1);
        // Android shows channel names in its own settings, and the widget draws
        // outside React entirely: neither follows a remount.
        void ensureChannels();
        void refreshWidget();
      }),
    [],
  );

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <LiveProvider>
          <StatusBar style="light" />
          <Stack
            key={languageKey}
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.bg },
              animation: 'slide_from_right',
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="project/[id]" />
            <Stack.Screen name="setup" options={{ animation: 'fade' }} />
          </Stack>
        </LiveProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
