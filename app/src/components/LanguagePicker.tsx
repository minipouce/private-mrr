import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type } from '../theme';
import { languagePref, setLanguage, t, type LanguagePref } from '../i18n';

/**
 * Language selector.
 *
 * Three segments rather than a list: the set is small and fixed, and seeing all
 * the options at once beats opening a menu to discover them.
 *
 * `Français` is deliberately written in French and `English` in English. A
 * language you cannot yet read is easier to find under its own name than under
 * a translated one.
 */
export function LanguagePicker({ onChange }: { onChange?: () => void }) {
  const current = languagePref();

  const OPTIONS: { value: LanguagePref; label: string }[] = [
    { value: 'auto', label: t('languageAuto') },
    { value: 'en', label: t('languageEnglish') },
    { value: 'fr', label: t('languageFrench') },
  ];

  const choose = (value: LanguagePref) => {
    if (value === current) return;
    setLanguage(value);
    onChange?.();
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {OPTIONS.map((option) => {
          const active = option.value === current;
          return (
            <Pressable
              key={option.value}
              onPress={() => choose(option.value)}
              style={[styles.segment, active && styles.segmentActive]}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.label, active && styles.labelActive]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.hint}>
        {current === 'auto' ? `${t('languageAutoHint')} · ` : ''}
        {t('languageNotifyHint')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  row: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceHi,
    borderRadius: radius.md,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: colors.accent },
  label: { ...type.body, color: colors.textDim },
  labelActive: { color: colors.text, fontWeight: '600' },
  hint: { ...type.caption, color: colors.textDim },
});
