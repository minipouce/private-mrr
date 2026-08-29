import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Switch, Alert, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useLive } from '../../src/hooks/useLive';
import { usePush } from '../../src/hooks/usePush';
import { api } from '../../src/api/client';
import { clearConfig, loadConfig } from '../../src/api/config';
import { colors, radius, space, type } from '../../src/theme/index';
import { Card, SectionTitle, Divider } from '../../src/components/ui';
import { money, timeAgo } from '../../src/lib/format';
import { ProjectLogo } from '../../src/components/ProjectLogo';
import { GoalEditor } from '../../src/components/GoalEditor';
import type { NotificationPrefs, ProjectInfo } from '../../src/api/types';

export default function Settings() {
  const insets = useSafeAreaInsets();
  const { overview, status, refresh } = useLive();
  const push = usePush();

  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [prefs, setPrefs] = useState<Record<string, NotificationPrefs>>({});
  const [syncing, setSyncing] = useState(false);
  const [goal, setGoal] = useState<{ cents: number; kind: string } | null>(null);

  const loadAll = useCallback(async () => {
    const config = await loadConfig();
    setServerUrl(config?.baseUrl ?? null);
    try {
      const [list, prefList, globalGoal] = await Promise.all([
        api.projects(),
        api.prefs(),
        api.goal(),
      ]);
      setProjects(list);
      setPrefs(Object.fromEntries(prefList.map((p) => [p.project_id, p])));
      setGoal(globalGoal);
    } catch {
      // Écran de réglages : on tolère l'absence de réseau sans bloquer.
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const toggleIncluded = async (projectId: string, current: boolean) => {
    // Mise à jour optimiste, comme pour les préférences de notification.
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? { ...p, includedInTotals: !current } : p)),
    );
    try {
      await api.setProjectIncluded(projectId, !current);
      await refresh();
    } catch {
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, includedInTotals: current } : p)),
      );
      Alert.alert('Échec', "Le réglage n'a pas pu être enregistré.");
    }
  };

  const togglePref = async (
    projectId: string,
    key: 'notify_payments' | 'notify_signups' | 'notify_cancels' | 'notify_failures',
  ) => {
    const current = prefs[projectId];
    if (!current) return;

    const next = current[key] === 1 ? false : true;
    // Mise à jour optimiste : l'interrupteur répond immédiatement, et l'on
    // revient en arrière si le serveur refuse.
    setPrefs((prev) => ({
      ...prev,
      [projectId]: { ...current, [key]: next ? 1 : 0 },
    }));

    try {
      const updated = await api.updatePrefs(projectId, { [key]: next });
      setPrefs((prev) => ({ ...prev, [projectId]: updated }));
    } catch {
      setPrefs((prev) => ({ ...prev, [projectId]: current }));
      Alert.alert('Échec', "La préférence n'a pas pu être enregistrée.");
    }
  };

  const testNotification = async () => {
    if (push.status !== 'granted') {
      const ok = await push.register();
      if (!ok) {
        Alert.alert('Notifications', push.error ?? 'Activation impossible');
        return;
      }
    }
    try {
      const result = await api.testPush();
      Alert.alert(
        'Test envoyé',
        result.sent > 0
          ? `Notification envoyée à ${result.sent} appareil${result.sent > 1 ? 's' : ''}.`
          : 'Aucun appareil enregistré côté serveur.',
      );
    } catch (err) {
      Alert.alert('Échec', (err as Error).message);
    }
  };

  const reconcile = async () => {
    setSyncing(true);
    try {
      const result = await api.reconcile();
      await refresh();
      Alert.alert('Synchronisation', `${result.reconciled} abonnements resynchronisés depuis Stripe.`);
    } catch (err) {
      Alert.alert('Échec', (err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const disconnect = () => {
    Alert.alert(
      'Se déconnecter',
      "L'adresse du serveur et le jeton seront effacés de cet appareil.",
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Se déconnecter',
          style: 'destructive',
          onPress: async () => {
            await clearConfig();
            router.replace('/setup');
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + space.md, paddingBottom: space.xxl },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.title}>Réglages</Text>

      <SectionTitle>Serveur</SectionTitle>
      <Card>
        <Row label="Adresse" value={serverUrl ?? '—'} mono />
        <Divider />
        <Row
          label="État"
          value={status === 'live' ? 'Connecté en direct' : status === 'offline' ? 'Hors ligne' : status}
          valueColor={status === 'live' ? colors.positive : colors.warning}
        />
        {overview && (
          <>
            <Divider />
            <Row label="Dernier calcul" value={timeAgo(overview.generatedAt)} />
          </>
        )}
      </Card>

      <SectionTitle>Notifications</SectionTitle>
      <Card>
        <Row
          label="Autorisation"
          value={
            push.status === 'granted'
              ? 'Accordée'
              : push.status === 'denied'
                ? 'Refusée'
                : push.status === 'unsupported'
                  ? 'Appareil non compatible'
                  : 'Non demandée'
          }
          valueColor={push.status === 'granted' ? colors.positive : colors.textDim}
        />
        {push.error && <Text style={styles.hint}>{push.error}</Text>}
        <Divider />
        <Pressable onPress={testNotification} style={styles.action}>
          <Text style={styles.actionText}>
            {push.status === 'granted' ? 'Envoyer une notification test' : 'Activer les notifications'}
          </Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      </Card>

      <SectionTitle>Objectif global</SectionTitle>
      <Card>
        <GoalEditor
          label="OBJECTIF CONSOLIDÉ, TOUS PROJETS CONFONDUS"
          cents={goal?.cents ?? null}
          kind={goal?.kind === 'arr' ? 'arr' : 'mrr'}
          onSave={async (cents, kind) => {
            const saved = await api.setGlobalGoal(cents, kind);
            setGoal(saved);
            await refresh();
          }}
        />
      </Card>

      <SectionTitle>Alertes et objectifs par projet</SectionTitle>
      <View style={styles.projectPrefs}>
        {projects.map((project) => {
          const pref = prefs[project.id];
          if (!pref) return null;
          return (
            <Card key={project.id} style={styles.prefCard}>
              <View style={styles.prefHeader}>
                <ProjectLogo
                  projectId={project.id}
                  color={project.color}
                  hasLogo={project.hasLogo}
                  size={22}
                />
                <Text style={styles.prefName}>{project.name}</Text>
                {!project.connected && <Text style={styles.badgeDemo}>démo</Text>}
              </View>

              <GoalEditor
                label="OBJECTIF DE CE PROJET"
                cents={project.goal_cents}
                kind={project.goal_kind === 'arr' ? 'arr' : 'mrr'}
                onSave={async (cents, kind) => {
                  const saved = await api.setProjectGoal(project.id, cents, kind);
                  setProjects((prev) => prev.map((p) => (p.id === project.id ? saved : p)));
                  await refresh();
                }}
              />
              <View style={styles.prefSep} />
              <PrefToggle
                label="Compter dans le total"
                value={project.includedInTotals !== false}
                onChange={() => toggleIncluded(project.id, project.includedInTotals !== false)}
              />
              <View style={styles.prefSep} />
              <PrefToggle
                label="Paiements"
                value={pref.notify_payments === 1}
                onChange={() => togglePref(project.id, 'notify_payments')}
              />
              <PrefToggle
                label="Nouveaux abonnés"
                value={pref.notify_signups === 1}
                onChange={() => togglePref(project.id, 'notify_signups')}
              />
              <PrefToggle
                label="Annulations"
                value={pref.notify_cancels === 1}
                onChange={() => togglePref(project.id, 'notify_cancels')}
              />
              <PrefToggle
                label="Échecs de paiement"
                value={pref.notify_failures === 1}
                onChange={() => togglePref(project.id, 'notify_failures')}
              />

              {pref.min_amount_cents > 0 && (
                <Text style={styles.hint}>
                  Seuls les paiements ≥ {money(pref.min_amount_cents)} déclenchent une alerte.
                </Text>
              )}

              {project.sync?.last_error && (
                <Text style={styles.syncError}>Erreur Stripe : {project.sync.last_error}</Text>
              )}
            </Card>
          );
        })}
        {projects.length === 0 && <Text style={styles.hint}>Aucun projet configuré.</Text>}
      </View>

      <SectionTitle>Maintenance</SectionTitle>
      <Card>
        <Pressable onPress={reconcile} disabled={syncing} style={styles.action}>
          <View>
            <Text style={styles.actionText}>Resynchroniser avec Stripe</Text>
            <Text style={styles.actionHint}>Rattrape un webhook manqué</Text>
          </View>
          {syncing ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.chevron}>›</Text>}
        </Pressable>
        <Divider />
        <Pressable onPress={disconnect} style={styles.action}>
          <Text style={[styles.actionText, { color: colors.negative }]}>Se déconnecter</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      </Card>
    </ScrollView>
  );
}

function Row({
  label,
  value,
  valueColor,
  mono,
}: {
  label: string;
  value: string;
  valueColor?: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[styles.rowValue, valueColor ? { color: valueColor } : null, mono && styles.mono]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

function PrefToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: () => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.surfaceHi, true: colors.accent }}
        thumbColor="#fff"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: space.lg },
  title: { ...type.title, color: colors.text },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md },
  rowLabel: { ...type.body, color: colors.textDim, fontSize: 14 },
  rowValue: { ...type.body, color: colors.text, fontSize: 13.5, flexShrink: 1, textAlign: 'right' },
  mono: { fontSize: 12 },
  action: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 },
  actionText: { ...type.body, color: colors.accent, fontSize: 14.5 },
  actionHint: { ...type.caption, color: colors.textFaint, fontSize: 10.5, marginTop: 2 },
  chevron: { color: colors.textFaint, fontSize: 20 },
  hint: { ...type.caption, color: colors.textFaint, fontSize: 11, marginTop: space.sm, lineHeight: 16 },
  syncError: { ...type.caption, color: colors.negative, fontSize: 11, marginTop: space.sm },
  projectPrefs: { gap: space.md },
  prefCard: { gap: space.sm },
  prefHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.xs },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
  prefName: { ...type.heading, color: colors.text, fontSize: 15, flex: 1 },
  badgeDemo: {
    ...type.caption,
    color: colors.textFaint,
    fontSize: 9.5,
    backgroundColor: colors.surfaceHi,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  prefSep: { height: 1, backgroundColor: colors.borderSoft, marginVertical: 4 },
  toggleLabel: { ...type.body, color: colors.textDim, fontSize: 14 },
});
