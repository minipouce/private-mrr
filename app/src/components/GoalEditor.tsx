import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { colors, radius, space, type } from '../theme';
import { t } from '../i18n';

/**
 * Revenue goal input.
 *
 * The amount is typed in whole units, since a goal is set in euros rather than
 * cents, and converted on save. An empty or zero field removes the goal, which
 * avoids a separate delete button.
 */
export function GoalEditor({
  label,
  cents,
  kind,
  currency = '€',
  onSave,
}: {
  label: string;
  cents: number | null;
  kind: 'mrr' | 'arr';
  currency?: string;
  onSave: (cents: number | null, kind: 'mrr' | 'arr') => Promise<void>;
}) {
  const [text, setText] = useState(cents ? String(Math.round(cents / 100)) : '');
  const [current, setCurrent] = useState<'mrr' | 'arr'>(kind);
  const [busy, setBusy] = useState(false);

  // A change coming from the server (another device, a reload) must show up
  // here as long as the user is not currently typing.
  useEffect(() => {
    if (!busy) setText(cents ? String(Math.round(cents / 100)) : '');
  }, [cents, busy]);

  const dirty =
    (Number(text || 0) * 100 || null) !== (cents ?? null) || current !== kind;

  const save = async () => {
    setBusy(true);
    try {
      const value = Number(text.replace(/[^0-9]/g, ''));
      await onSave(Number.isFinite(value) && value > 0 ? value * 100 : null, current);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>

      <View style={styles.row}>
        <View style={styles.inputWrap}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={(v) => setText(v.replace(/[^0-9]/g, ''))}
            placeholder={t('none')}
            placeholderTextColor={colors.textFaint}
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={9}
          />
          <Text style={styles.currency}>{currency}</Text>
        </View>

        <View style={styles.toggle}>
          {(['mrr', 'arr'] as const).map((k) => (
            <Pressable
              key={k}
              onPress={() => setCurrent(k)}
              style={[styles.toggleItem, current === k && styles.toggleItemOn]}
            >
              <Text style={[styles.toggleText, current === k && styles.toggleTextOn]}>
                {k.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={save}
          disabled={!dirty || busy}
          style={[styles.save, (!dirty || busy) && styles.saveOff]}
        >
          {busy ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.saveText}>OK</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  label: { ...type.caption, color: colors.textFaint, fontSize: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.md,
  },
  input: { flex: 1, ...type.body, ...type.tabular, color: colors.text, paddingVertical: 9 },
  currency: { ...type.body, color: colors.textFaint },
  toggle: {
    flexDirection: 'row',
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  toggleItem: { paddingHorizontal: 10, paddingVertical: 9 },
  toggleItemOn: { backgroundColor: colors.accentSoft },
  toggleText: { ...type.caption, color: colors.textFaint, fontSize: 10 },
  toggleTextOn: { color: colors.accent },
  save: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 9,
    minWidth: 44,
    alignItems: 'center',
  },
  saveOff: { backgroundColor: colors.surfaceHi },
  saveText: { ...type.caption, color: '#fff', fontSize: 11 },
});
