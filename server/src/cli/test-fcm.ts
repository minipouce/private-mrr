/**
 * Vérifie la chaîne d'authentification FCM sans notifier personne.
 *
 *   npm run test:fcm              -> valide l'authentification OAuth2
 *   npm run test:fcm -- <jeton>   -> envoie réellement à un appareil
 */
import { sendToDevice, isConfigured, fcmProjectId } from '../push/fcm.js';

console.log('configuré :', isConfigured());
console.log('projet    :', fcmProjectId());

const target = process.argv[2];

if (!target) {
  console.log(
    "\nEnvoi vers un jeton volontairement invalide.\n" +
      "Un rejet pour « jeton invalide » prouve que l'authentification OAuth2 a abouti ;\n" +
      "une erreur 401/403 signalerait une clé refusée ou l'API FCM désactivée.\n",
  );
}

const result = await sendToDevice({
  token: target ?? 'jeton_de_test_volontairement_invalide',
  title: target ? '✅ Test direct FCM' : 'Test',
  body: target
    ? 'Envoyé depuis ton serveur, sans intermédiaire.'
    : 'Test',
});

console.log(JSON.stringify(result, null, 2));
