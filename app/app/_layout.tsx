import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { LiveProvider } from '../src/hooks/useLive';
import { ensureChannels } from '../src/hooks/usePush';
import { colors } from '../src/theme/index';

export default function RootLayout() {
  // Les canaux doivent exister avant toute notification, indépendamment de
  // l'écran affiché et du fait que l'appareil soit déjà enregistré.
  useEffect(() => {
    void ensureChannels();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <LiveProvider>
          <StatusBar style="light" />
          <Stack
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
