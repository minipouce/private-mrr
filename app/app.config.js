/**
 * Configuration dynamique Expo.
 *
 * Reprend `app.json` et n'y ajoute `googleServicesFile` que si le fichier
 * existe réellement. Sans cette condition, un `prebuild` échouerait tant que
 * Firebase n'est pas configuré — alors que tout le reste de l'app fonctionne
 * parfaitement sans notifications push.
 */
const fs = require('fs');
const path = require('path');

const GOOGLE_SERVICES = 'google-services.json';

/**
 * Identité de l'application, surchargeable par l'environnement.
 *
 * Une personne qui reprend ce projet a besoin de son propre nom de paquet, de
 * son propre projet Firebase et de son propre compte Expo. Les valeurs de
 * `app.json` restent celles de l'auteur ; ces variables permettent de les
 * remplacer sans modifier le dépôt.
 */
function identity(config) {
  const pkg = process.env.APP_PACKAGE?.trim();
  const owner = process.env.EAS_OWNER?.trim();
  const projectId = process.env.EAS_PROJECT_ID?.trim();

  return {
    ...config,
    ...(owner ? { owner } : {}),
    android: { ...config.android, ...(pkg ? { package: pkg } : {}) },
    extra: {
      ...config.extra,
      ...(projectId
        ? { eas: { ...(config.extra?.eas ?? {}), projectId } }
        : {}),
    },
  };
}

module.exports = ({ config: rawConfig }) => {
  const config = identity(rawConfig);
  const absolute = path.join(__dirname, GOOGLE_SERVICES);

  if (!fs.existsSync(absolute)) {
    console.warn(
      `\n  ${GOOGLE_SERVICES} not found. Building without push notifications.` +
        `\n  See the README, "Firebase, for notifications".\n`,
    );
    return config;
  }

  // Vérifie que le fichier Firebase correspond bien au paquet Android déclaré :
  // une incohérence produit sinon un build qui se termine sans erreur mais dont
  // les notifications ne partiront jamais.
  try {
    const services = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const declared = config.android?.package;
    const packages = (services.client ?? [])
      .map((c) => c?.client_info?.android_client_info?.package_name)
      .filter(Boolean);

    if (declared && packages.length > 0 && !packages.includes(declared)) {
      throw new Error(
        `google-services.json declares [${packages.join(', ')}] ` +
          `but app.json expects "${declared}". ` +
          `Re-create the Android app in Firebase with the matching package name.`,
      );
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`${GOOGLE_SERVICES} is not valid JSON.`);
    }
    throw err;
  }

  return {
    ...config,
    android: { ...config.android, googleServicesFile: `./${GOOGLE_SERVICES}` },
  };
};
