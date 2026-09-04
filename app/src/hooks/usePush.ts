import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import { api } from '../api/client';
import { loadConfig } from '../api/config';
import { refreshWidget } from '../widget/refresh';
import { activeLanguage, t } from '../i18n';

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

/**
 * Fetches the FCM token and hands it to the server, with the device language.
 *
 * Shared by the explicit "enable" tap and the silent sync at launch. One
 * in-flight call is reused: the root layout and the settings screen both mount
 * the hook, and there is no point sending the same token twice in a row.
 */
let inflight: Promise<string> | null = null;

function syncToken(): Promise<string> {
  if (inflight) return inflight;
  inflight = (async () => {
    // Android channel: carries HIGH importance, required for the notification
    // to appear as a heads-up banner and vibrate rather than stay silent.
    await ensureChannels();

    // A native FCM token, not an Expo token: the server sends straight to
    // Firebase without going through Expo's push service. Notification
    // contents therefore pass through no extra intermediary.
    const devicePushToken = await Notifications.getDevicePushTokenAsync();
    const fcmToken = String(devicePushToken.data);

    const config = await loadConfig();
    if (!config) throw new Error(t('pushConfigureFirst'));

    // The language travels with the token: the server composes each
    // notification in the language of the device it is sending to.
    await api.registerPush(fcmToken, Device.deviceName ?? 'Android', activeLanguage());
    return fcmToken;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Turns a token failure into a status and a message the user can act on. */
function classify(err: unknown): { status: PushStatus; message: string } {
  const message = (err as Error).message;
  // Most common cause: Google Play Services missing (bare emulator,
  // de-Googled ROM). Firebase's raw message does not help the user.
  const missingPlayServices = /play services|SERVICE_NOT_AVAILABLE|MISSING_INSTANCEID/i.test(message);
  return missingPlayServices
    ? { status: 'unsupported', message: t('pushDevicePhysical') }
    : { status: 'error', message };
}

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

      const fcmToken = await syncToken();
      setToken(fcmToken);
      setStatus('granted');
      setError(null);
      registered.current = true;
      return true;
    } catch (err) {
      const outcome = classify(err);
      setStatus(outcome.status);
      setError(outcome.message);
      return false;
    }
  }, []);

  useEffect(() => {
    void ensureChannels();
  }, []);

  /**
   * Syncs the token on every launch once permission has been granted.
   *
   * FCM tokens rotate, and the server only learns the device language through
   * this call. Without it, a phone that tapped "enable" once keeps the token
   * and language it had that day for ever: the server was still holding a
   * registration from the first afternoon, in English, a week later.
   *
   * Permission is only checked, never requested, so this never prompts. The
   * status is set from the permission straight away, so the settings screen
   * does not read "not requested" while the token fetch is still running.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await Notifications.getPermissionsAsync();
        if (!existing.granted || cancelled) return;
        setStatus('granted');
        const fcmToken = await syncToken();
        if (cancelled) return;
        setToken(fcmToken);
        registered.current = true;
      } catch (err) {
        if (cancelled) return;
        const outcome = classify(err);
        setStatus(outcome.status);
        setError(outcome.message);
      }
    })();
    return () => {
      cancelled = true;
    };
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
