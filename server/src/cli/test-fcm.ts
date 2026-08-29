/**
 * Verifies the FCM authentication chain without notifying anyone.
 *
 *   npm run test:fcm              -> validates OAuth2 authentication
 *   npm run test:fcm -- <token>   -> actually sends to a device
 */
import { sendToDevice, isConfigured, fcmProjectId } from '../push/fcm.js';

console.log('configured :', isConfigured());
console.log('project    :', fcmProjectId());

const target = process.argv[2];

if (!target) {
  console.log(
    '\nSending to a deliberately invalid token.\n' +
      'A rejection for "invalid token" proves OAuth2 authentication succeeded;\n' +
      'a 401 or 403 would mean a refused key or a disabled FCM API.\n',
  );
}

const result = await sendToDevice({
  token: target ?? 'jeton_de_test_volontairement_invalide',
  title: target ? '✅ Direct FCM test' : 'Test',
  body: target
    ? 'Sent from your server, with no intermediary.'
    : 'Test',
});

console.log(JSON.stringify(result, null, 2));
