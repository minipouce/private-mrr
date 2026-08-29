import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import { api } from '../api/client';
import { loadConfig } from '../api/config';
import { refreshWidget } from '../widget/refresh';
import { t } from '../i18n';

// Une notification reçue app ouverte doit rester visible : sans cela, un
// paiement qui tombe pendant la consultation passe totalement inaperçu.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Crée les canaux de notification Android.
 *
 * Appelée au démarrage et non seulement à l'activation : le son d'un canal est
 * figé à sa création et ne peut plus être modifié. Un appareil déjà enregistré
 * ne repasserait jamais par la demande d'autorisation, et n'obtiendrait donc
 * jamais le canal porteur du son de caisse.
 *
 * `setNotificationChannelAsync` est idempotente : rejouer la création d'un canal
 * existant ne fait rien, et ne réinitialise pas les réglages de l'utilisateur.
 */
export async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync('payments', {
    name: 'Paiements reçus',
    description: 'Encaissements, avec son de caisse',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 200, 100, 200],
    lightColor: '#22D39A',
    sound: 'cash.mp3',
    enableVibrate: true,
  });

  await Notifications.setNotificationChannelAsync('revenue', {
    name: 'Abonnements et incidents',
    description: 'Nouveaux abonnés, annulations, échecs de paiement',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 200, 100, 200],
    lightColor: '#6366F1',
    sound: 'default',
    enableVibrate: true,
  });
}

export type PushStatus = 'idle' | 'registering' | 'granted' | 'denied' | 'unsupported' | 'error';

export function usePush() {
  const [status, setStatus] = useState<PushStatus>('idle');
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const registered = useRef(false);

  const register = useCallback(async (): Promise<boolean> => {
    // On ne bloque pas sur `Device.isDevice` : un émulateur doté de Google Play
    // Services obtient un jeton FCM parfaitement valide. Le seul juge fiable est
    // la demande de jeton elle-même, dont l'échec est traité plus bas.
    setStatus('registering');
    try {
      // Canal Android : porte l'importance HIGH, indispensable pour que la
      // notification s'affiche en bandeau et vibre plutôt que de rester muette.
      await ensureChannels();

      const existing = await Notifications.getPermissionsAsync();
      let granted = existing.granted;
      if (!granted) {
        const asked = await Notifications.requestPermissionsAsync();
        granted = asked.granted;
      }

      if (!granted) {
        setStatus('denied');
        setError(t('pushDeniedSettings'));
        return false;
      }

      // Jeton FCM natif, et non un jeton Expo : le serveur envoie directement
      // vers Firebase, sans passer par le service push d'Expo. Le contenu des
      // notifications ne transite donc par aucun intermédiaire supplémentaire.
      const devicePushToken = await Notifications.getDevicePushTokenAsync();
      const fcmToken = String(devicePushToken.data);

      const config = await loadConfig();
      if (!config) {
        setStatus('error');
        setError(t('pushConfigureFirst'));
        return false;
      }

      await api.registerPush(fcmToken, Device.deviceName ?? 'Android');
      setToken(fcmToken);
      setStatus('granted');
      setError(null);
      registered.current = true;
      return true;
    } catch (err) {
      const message = (err as Error).message;
      // Cause la plus fréquente : Google Play Services absent (émulateur nu,
      // ROM dégooglisée). Le message brut de Firebase n'aide pas l'utilisateur.
      const isMissingPlayServices = /play services|SERVICE_NOT_AVAILABLE|MISSING_INSTANCEID/i.test(
        message,
      );
      setStatus(isMissingPlayServices ? 'unsupported' : 'error');
      setError(
        isMissingPlayServices
          ? t('pushDevicePhysical')
          : message,
      );
      return false;
    }
  }, []);

  useEffect(() => {
    void ensureChannels();
  }, []);

  // Une notification signale précisément le moment où les chiffres changent :
  // c'est l'occasion la plus utile de redessiner le widget, bien plus que le
  // cycle de trente minutes imposé par Android.
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(() => {
      void refreshWidget();
    });
    return () => sub.remove();
  }, []);

  // Tap sur une notification : ouvre directement le projet concerné.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { projectId?: string };
      if (data?.projectId) router.push(`/project/${data.projectId}`);
    });
    return () => sub.remove();
  }, []);

  return { status, token, error, register, isRegistered: registered.current };
}
