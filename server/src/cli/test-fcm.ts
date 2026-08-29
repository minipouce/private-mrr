/**
 * Vérifie la chaîne d'authentification FCM sans notifier personne.
 *
 *   npm run test:fcm              -> valide l'authentification OAuth2
 *   npm run test:fcm -- <jeton>   -> envoie réellement à un appareil
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
