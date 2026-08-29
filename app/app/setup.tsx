import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { saveConfig, clearConfig } from '../src/api/config';
import { api } from '../src/api/client';
import { useLive } from '../src/hooks/useLive';
import { colors, radius, space, type } from '../src/theme/index';
import { t } from '../src/i18n';

/**
 * Allows cleartext HTTP only towards a private or loopback address. On the open
 * internet the token would travel in the clear and be interceptable, hence the
 * HTTPS requirement everywhere else. `10.0.2.2` is the alias through which the
 * Android emulator reaches the host machine.
 */
function isPrivateHost(url: string): boolean {
  const host = url.replace(/^https?:\/\//i, '').split(/[/:?#]/)[0] ?? '';
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '10.0.2.2' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export default function Setup() {
  const insets = useSafeAreaInsets();
  const { reconfigure } = useLive();

  const [url, setUrl] = useState('https://');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setError(null);

    const trimmed = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/i.test(trimmed)) {
      setError(t('errorHttps'));
      return;
    }
    if (!trimmed.startsWith('https://') && !isPrivateHost(trimmed)) {
      setError(t('errorHttpsRequired'));
      return;
    }
    if (token.trim().length < 16) {
      setError(t('errorTokenShort'));
      return;
    }

    setBusy(true);
    try {
      await saveConfig(trimmed, token);
      // Check the address/token pair works right away, rather than letting the
      // user discover the failure on an empty screen.
      await api.overview();
      await reconfigure();
      router.replace('/');
    } catch (err) {
      await clearConfig();
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + space.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brandMark}>
          <Text style={styles.brandGlyph}>◈</Text>
        </View>

        <Text style={styles.title}>{t('setupTitle')}</Text>
        <Text style={styles.subtitle}>{t('setupSubtitle')}</Text>

        <View style={styles.field}>
          <Text style={styles.label}>{t('serverAddress')}</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder={t('serverPlaceholder')}
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>{t('apiToken')}</Text>
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            placeholder={t('apiTokenPlaceholder')}
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
        </View>

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <Pressable
          onPress={connect}
          disabled={busy}
          style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>{t('connect')}</Text>
          )}
        </Pressable>

        <Text style={styles.footnote}>{t('setupFootnote')}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: space.xl, paddingBottom: space.xxl },
  brandMark: {
    width: 54,
    height: 54,
    borderRadius: radius.lg,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xl,
  },
  brandGlyph: { fontSize: 26, color: colors.accent },
  title: { ...type.title, color: colors.text, marginBottom: space.sm },
  subtitle: { ...type.body, color: colors.textDim, fontSize: 14, lineHeight: 21, marginBottom: space.xxl },
  field: { marginBottom: space.lg, gap: space.sm },
  label: { ...type.caption, color: colors.textFaint, fontSize: 10 },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
    color: colors.text,
    ...type.body,
  },
  errorBox: {
    backgroundColor: colors.negativeSoft,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.lg,
  },
  errorText: { ...type.body, color: colors.negative, fontSize: 13.5 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: space.sm,
  },
  buttonPressed: { opacity: 0.75 },
  buttonText: { ...type.body, color: '#fff', fontSize: 15.5, fontWeight: '700' },
  footnote: {
    ...type.caption,
    color: colors.textFaint,
    textAlign: 'center',
    marginTop: space.xl,
    lineHeight: 17,
  },
});
