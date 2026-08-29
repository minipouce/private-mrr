import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import { api } from '../api/client';
import { loadConfig } from '../api/config';
import { refreshWidget } from '../widget/refresh';
import { t } from '../i18n';

// A notification received while the app is open must stay visible: without
// this, a payment landing mid-session goes completely unnoticed.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Creates the Android notification channels.
 *
 * Called at startup and not only on opt-in, because a channel's sound is frozen
 * at creation and can never be changed afterwards. An already registered device
 * would never go through the permission request again, and so would never get
 * the channel carrying the cash register sound.
 *
 * `setNotificationChannelAsync` is idempotent: recreating an existing channel
 * does nothing and does not reset the user's own settings.
 */
export async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync('payments', {
    name: t('channelPayments'),
    description: t('channelPaymentsHint'),
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 200, 100, 200],
    lightColor: '#22D39A',
    sound: 'cash.mp3',
    enableVibrate: true,
  });

  await Notifications.setNotificationChannelAsync('revenue', {
    name: t('channelRevenue'),
    description: t('channelRevenueHint'),
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
    // Do not gate on `Device.isDevice`: an emulator with Google Play Services
    // gets a perfectly valid FCM token. The only reliable judge is the token
    // request itself, whose failure is handled below.
    setStatus('registering');
    try {
      // Android channel: carries HIGH importance, required for the notification
      // to appear as a heads-up banner and vibrate rather than stay silent.
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

      // A native FCM token, not an Expo token: the server sends straight to
      // Firebase without going through Expo's push service. Notification
      // contents therefore pass through no extra intermediary.
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
      // Most common cause: Google Play Services missing (bare emulator,
      // de-Googled ROM). Firebase's raw message does not help the user.
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

  // A notification marks exactly the moment the figures change, which is the
  // most useful time to redraw the widget, far more than the thirty-minute
  // cycle Android imposes.
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(() => {
      void refreshWidget();
    });
    return () => sub.remove();
  }, []);

  // Tapping a notification opens the project it concerns.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { projectId?: string };
      if (data?.projectId) router.push(`/project/${data.projectId}`);
    });
    return () => sub.remove();
  }, []);

  return { status, token, error, register, isRegistered: registered.current };
}
