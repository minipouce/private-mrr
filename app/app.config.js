/**
 * Configuration dynamique Expo.
 *
 * Takes `app.json` and adds `googleServicesFile` only if the file actually
 * exists. Without that condition a `prebuild` would fail until Firebase is
 * configured, even though everything else in the app works perfectly well
 * without push notifications.
 */
const fs = require('fs');
const path = require('path');

const GOOGLE_SERVICES = 'google-services.json';

/**
 * Application identity, overridable through the environment.
 *
 * Une personne qui reprend ce projet a besoin de son propre nom de paquet, de
 * son propre projet Firebase et de son propre compte Expo. Les valeurs de
 * `app.json` remain the author's; these variables replace them without
 * modifying the repository.
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

  // Check the Firebase file matches the declared Android package: a mismatch
  // otherwise produces a build that finishes without error but whose
  // notifications will never be sent.
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
