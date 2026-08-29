import React from 'react';
import { Text, StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, type } from '../../src/theme/index';
import { t } from '../../src/i18n';

/**
 * Typographic icons rather than an icon library: less weight in the bundle and
 * identical rendering across every Android version.
 */
function TabIcon({ glyph, focused }: { glyph: string; focused: boolean }) {
  return (
    <View style={styles.iconBox}>
      <Text style={[styles.glyph, { color: focused ? colors.accent : colors.textFaint }]}>
        {glyph}
      </Text>
    </View>
  );
}

export default function TabsLayout() {
  // Android 16 enforces edge-to-edge: without this inset, the tab bar slides
  // under the system navigation bar and becomes unreadable.
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: [
          styles.bar,
          { height: 62 + insets.bottom, paddingBottom: 8 + insets.bottom },
        ],
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarLabelStyle: styles.label,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabDashboard'),
          tabBarIcon: ({ focused }) => <TabIcon glyph="◈" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: t('tabActivity'),
          tabBarIcon: ({ focused }) => <TabIcon glyph="≡" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabSettings'),
          tabBarIcon: ({ focused }) => <TabIcon glyph="⚙" focused={focused} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.bgElevated,
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    height: 62,
    paddingTop: 6,
    paddingBottom: 8,
  },
  label: { ...type.caption, fontSize: 10.5, marginTop: 2 },
  iconBox: { alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 19 },
});
