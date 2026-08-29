/**
 * Plugin de configuration Expo : politique de sécurité réseau Android.
 *
 * Par défaut Android autorise ou interdit le trafic en clair de façon globale.
 * On veut mieux : interdire le HTTP partout — le jeton d'API y circulerait en
 * clair et serait interceptable sur un réseau hostile — sauf vers la boucle
 * locale et l'alias `10.0.2.2` par lequel l'émulateur atteint la machine hôte.
 *
 * Ces trois adresses ne quittent jamais l'appareil ou la machine de
 * développement : l'exception n'ouvre donc aucune surface réelle.
 */
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const { promises: fs } = require('fs');
const path = require('path');

/** Hôtes toujours autorisés en clair : ils ne quittent jamais la machine. */
const ALWAYS_ALLOWED = ['localhost', '127.0.0.1', '10.0.2.2'];

function buildXml(hosts) {
  const entries = hosts
    .map((h) => `        <domain includeSubdomains="false">${h}</domain>`)
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Généré par plugins/withNetworkSecurity.js — ne pas éditer à la main. -->
<network-security-config>
    <!-- Règle générale : HTTPS obligatoire. -->
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>

    <!-- Exceptions limitées au développement local. -->
    <domain-config cleartextTrafficPermitted="true">
${entries}
    </domain-config>
</network-security-config>
`;
}

module.exports = function withNetworkSecurity(config) {
  // Hôtes de développement supplémentaires, déclarés dans app.json sous
  // `extra.devCleartextHosts` — typiquement l'IP de la machine de développement
  // pour tester depuis un téléphone réel sur le réseau local, par exemple
  // ["192.168.1.39"]. En production l'API passe par HTTPS : la liste reste vide,
  // et le HTTP en clair est alors refusé partout sauf boucle locale et émulateur.
  const extra = config.extra?.devCleartextHosts ?? [];
  const hosts = [...new Set([...ALWAYS_ALLOWED, ...extra])];

  if (extra.length > 0) {
    console.warn(
      `\n  HTTP en clair autorisé vers : ${extra.join(', ')}` +
        `\n  À retirer de app.json (extra.devCleartextHosts) avant tout usage hors réseau local.\n`,
    );
  }

  // 1. Écrit la ressource XML dans le projet natif.
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const dir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app/src/main/res/xml',
      );
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'network_security_config.xml'),
        buildXml(hosts),
        'utf8',
      );
      return cfg;
    },
  ]);

  // 2. Référence la ressource et retire l'attribut global, que la config remplace.
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) return cfg;

    application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    delete application.$['android:usesCleartextTraffic'];

    return cfg;
  });
};
