# Private MRR

Suivi temps réel du chiffre d'affaires sur plusieurs comptes Stripe, depuis un
téléphone Android. Auto-hébergé, aucune dépendance à un service tiers de
tableau de bord.

- **Serveur** — reçoit les webhooks Stripe, agrège les métriques, envoie les
  notifications. C'est le seul endroit où vivent les clés Stripe.
- **App Android** — affiche les chiffres en direct. Ne détient qu'un jeton de
  lecture, révocable en une ligne.

---

## Architecture

```
   Stripe (N comptes)
        │
        │  webhooks signés (temps réel, ~1 s)
        │  API REST (historique + réconciliation horaire)
        ▼
   ┌──────────────────────────────┐
   │  TON VPS                     │
   │  ┌────────────────────────┐  │
   │  │ Caddy (HTTPS)          │  │
   │  └───────────┬────────────┘  │
   │              │ 127.0.0.1     │
   │  ┌───────────▼────────────┐  │
   │  │ Conteneur mrr-server   │  │
   │  │ Node · SQLite          │  │
   │  │ ← les clés Stripe      │  │
   │  └───────────┬────────────┘  │
   └──────────────┼───────────────┘
                  │ HTTPS · Bearer + SSE
                  ▼
           App Android (0 clé Stripe)
```

**Pourquoi des webhooks et pas seulement des appels API ?** Interroger l'API
Stripe en boucle serait lent, coûteux en quota, et jamais réellement instantané.
Les webhooks poussent l'événement en une seconde environ. L'API sert à l'inverse
pour ce que les webhooks ne peuvent pas donner : l'historique long (Stripe ne
conserve ses événements que 30 jours) et une réconciliation horaire qui rattrape
tout webhook perdu pendant un redéploiement.

---

## Sécurité

Les décisions structurantes, et pourquoi.

**Les clés Stripe ne quittent jamais le serveur.** Une clé embarquée dans un APK
est extractible en quelques minutes : le bundle JavaScript est lisible sur
l'appareil, même en build release. L'app ne reçoit que des chiffres agrégés.

**Utiliser des clés restreintes.** Dans le tableau de bord Stripe →
*Développeurs → Clés API → Créer une clé restreinte*. Une clé `rk_live_…` en
lecture seule suffit à ce projet, et ne permet ni remboursement, ni virement,
ni création de charge. Permissions nécessaires, toutes en **Lecture** :

| Ressource | Accès |
|---|---|
| Charges | Lecture |
| Customers | Lecture |
| Invoices | Lecture |
| Subscriptions | Lecture |
| Balance | Lecture |
| Events | Lecture |

Le serveur détecte au démarrage si une clé complète est utilisée et l'écrit
dans les journaux.

**Chaque webhook est vérifié.** Signature HMAC contrôlée sur le corps brut de la
requête, avec une tolérance temporelle de cinq minutes qui bloque aussi le rejeu
d'un webhook authentique capturé plus tôt. Sans cette vérification, n'importe qui
pourrait injecter de faux paiements. Un secret distinct par compte.

**Le jeton d'API est comparé en temps constant.** Une comparaison naïve laisse
fuiter la longueur du préfixe correct par le temps de réponse et permet de
reconstituer le jeton octet par octet.

**Côté téléphone**, le jeton est conservé dans `expo-secure-store`, chiffré par
le keystore Android — jamais dans un stockage lisible en clair sur un appareil
rooté.

**Le trafic en clair est interdit.** Une politique réseau Android
(`plugins/withNetworkSecurity.js`) impose HTTPS, avec pour seule exception la
boucle locale et l'alias `10.0.2.2` de l'émulateur — trois adresses qui ne
quittent jamais la machine.

**Le conteneur** tourne en utilisateur non privilégié, système de fichiers en
lecture seule hormis le volume de données, `no-new-privileges`, et son port
n'est publié que sur `127.0.0.1`.

**Les journaux** masquent systématiquement l'en-tête `Authorization` et la
signature Stripe.

**Les URL publiques ne divulguent rien.** `/health` ne renvoie que `{"ok":true}` :
volumes, nombre de projets et appareils connectés sont derrière le jeton, sur
`/api/status`. Les endpoints de webhook ne renvoient jamais de données, seulement
un accusé de réception. Un en-tête `X-Robots-Tag: noindex, nofollow, noarchive`
et un `robots.txt` restrictif écartent toute indexation.

**Le quota de requêtes couvre aussi les webhooks.** Les exempter garantissait de
ne perdre aucun événement lors d'un pic, mais laissait quiconque découvrant
l'URL inonder l'endpoint. Le plafond est fixé très au-dessus du trafic réel de
Stripe (1 000/min) tout en restant borné.

---

## Déploiement sur le VPS

Onze étapes, dans cet ordre. Compter une trentaine de minutes, dont la moitié
sur les webhooks Stripe s'il y a huit comptes.

### 1. Déposer le projet

```bash
git clone <ton-dépôt> /opt/private-mrr && cd /opt/private-mrr/server
```

### 2. Créer la configuration

```bash
cp .env.example .env && chmod 600 .env
openssl rand -hex 32          # à coller dans API_TOKEN
```

### 3. Déclarer les comptes Stripe

Dans `.env`, lister les identifiants puis un bloc par compte :

```bash
PROJECTS=projet-a,projet-b,projet-c

PROJECT_PROJET_A_NAME="Projet A"
PROJECT_PROJET_A_STRIPE_KEY=rk_live_xxx
PROJECT_PROJET_A_WEBHOOK_SECRET=          # rempli à l'étape 8
PROJECT_PROJET_A_COLOR="#6366f1"
```

Deux pièges :

- **Les guillemets autour de la couleur sont obligatoires.** Sans eux, `dotenv`
  voit un commentaire après le `#` et la valeur est silencieusement perdue.
- **Utiliser des clés restreintes** (`rk_live_…`), pas des clés secrètes
  complètes. Permissions requises, toutes en lecture seule : Charges, Customers,
  Invoices, Subscriptions, Balance, Events. Le serveur signale dans ses journaux
  s'il détecte une clé complète.

### 4. Déposer la clé Firebase

```bash
scp server/credentials/fcm-service-account.json vps:/opt/private-mrr/server/credentials/
ssh vps 'chmod 600 /opt/private-mrr/server/credentials/fcm-service-account.json'
```

Si ce fichier manque, tout fonctionne sauf les notifications, et le serveur le
dit au démarrage.

### 5. Démarrer

```bash
docker compose up -d --build
docker compose logs -f
```

Le premier démarrage compile un module natif : compter quelques minutes.

### 6. Vérifier

```bash
curl -s localhost:8791/health
```

Attendu : `{"ok":true,...,"push":{"configured":true,...}}`.

### 7. Exposer en HTTPS

Ajouter le contenu de `Caddyfile.example` au Caddyfile du VPS en adaptant le
domaine, puis `systemctl reload caddy`.

Le bloc dédié à `/api/stream` compte : sans `flush_interval -1`, Caddy met le
flux temps réel en tampon et les événements arrivent par paquets au lieu
d'arriver en direct.

### 8. Déclarer les webhooks Stripe

Pour **chaque** compte, dans Stripe → *Développeurs → Webhooks → Ajouter* :

- URL : `https://mrr.tondomaine.com/webhooks/stripe/<id-du-projet>`
  — l'identifiant est celui déclaré dans `PROJECTS`
- Événements : `invoice.paid`, `invoice.payment_failed`, `charge.succeeded`,
  `charge.refunded`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`

Copier chaque secret de signature (`whsec_…`) dans la variable
`PROJECT_<ID>_WEBHOOK_SECRET` correspondante.

### 9. Redémarrer et lancer l'historique

```bash
docker compose restart
docker compose logs -f      # suivre l'import
```

L'import de 24 mois se fait en arrière-plan ; le serveur répond pendant ce
temps. Pour le relancer : `docker compose exec mrr node dist/cli/backfill.js --force`.

### 10. Installer l'app

```bash
adb install -r app/android/app/build/outputs/apk/release/app-release.apk
```

Au premier lancement, saisir `https://mrr.tondomaine.com` et le jeton d'API.

### 11. Activer les notifications

Dans l'app : *Réglages → Activer les notifications*, puis *Envoyer une
notification test*.

---

## Ce qui n'a pas pu être testé

Par honnêteté, deux chemins n'ont jamais été exercés faute d'accès :

- **L'API Stripe avec de vraies clés.** Les webhooks ont été validés avec des
  charges utiles authentiquement signées, ce qui exerce le même code
  d'ingestion. Mais le backfill (`subscriptions.list`, `invoices.list`,
  `charges.list`) n'a jamais tourné contre un compte réel. Surveiller les
  journaux au premier démarrage.
- **La construction de l'image Docker.** Le démon Docker de la machine de
  développement ne pouvait pas récupérer l'image de base. En revanche
  `npm ci`, `npm run build` et l'exécution du code compilé ont été vérifiés :
  c'est l'essentiel de ce que fait le Dockerfile.

## Notifications push

Les notifications partent **directement de ton serveur vers Firebase**, sans
passer par le service push d'Expo. Le contenu — nom du client, montant — ne
transite donc par aucun intermédiaire au-delà de Google, incontournable pour du
push Android.

Le serveur s'authentifie auprès de Google avec une clé de compte de service :
il signe une assertion JWT (RS256), l'échange contre un jeton d'accès valable
une heure, et appelle l'API FCM HTTP v1. Pas de bibliothèque JWT tierce — le
module `crypto` de Node suffit et évite d'ajouter une dépendance qui manipule
des secrets.

### Configuration déjà en place

| Élément | Valeur |
|---|---|
| Projet Firebase | `cs2-mental-assistant` |
| Application Android | `com.tristan.privatemrr` |
| `app/google-services.json` | présent (ignoré par git) |
| `server/credentials/fcm-service-account.json` | présent (ignoré par git) |

L'application Android a été ajoutée à un projet Firebase existant plutôt que
créée dans un nouveau : le compte a atteint sa limite de projets. Un projet
Firebase héberge autant d'applications que nécessaire, et cela ne change rien
au fonctionnement.

### Vérifier

```bash
cd app && npm run check:push -- --server https://mrr.tondomaine.com
```

Le script contrôle le nom de paquet, la cohérence entre le fichier de l'app et
la clé du serveur, et interroge `/health` pour confirmer que FCM est actif et
combien d'appareils sont enregistrés.

### Déployer la clé

`docker-compose.yml` monte la clé en lecture seule depuis
`server/credentials/fcm-service-account.json`. Elle n'entre jamais dans l'image,
ce qui éviterait qu'elle se retrouve dans un registre ou un cache de couche.

Sur le VPS :

```bash
scp server/credentials/fcm-service-account.json vps:/opt/private-mrr/server/credentials/
ssh vps 'chmod 600 /opt/private-mrr/server/credentials/fcm-service-account.json'
```

> **Portée de cette clé.** Elle donne un accès administrateur au projet
> `cs2-mental-assistant`, qui héberge aussi ton autre application. Elle ne
> quitte pas ton serveur, mais si tu veux réduire cette portée, tu peux créer
> un compte de service dédié dans Google Cloud IAM avec le seul rôle
> *Firebase Cloud Messaging API Admin*, et remplacer le fichier.
> Pour révoquer : console Firebase → *Paramètres → Comptes de service*.

### Utilisation

Dans l'app : *Réglages → Activer les notifications*, puis *Envoyer une
notification test*. Les alertes se règlent par projet et par type — paiements,
nouveaux abonnés, annulations, échecs — avec un seuil de montant optionnel.

Le jeton FCM de l'appareil est obtenu via `getDevicePushTokenAsync()` et
enregistré côté serveur. Un appareil désinstallé renvoie `UNREGISTERED` au
premier envoi : son jeton est purgé automatiquement.

Google Play Services est requis sur l'appareil. À défaut, l'app l'indique
explicitement plutôt que d'échouer en silence.

## Compiler l'APK

Prérequis : JDK 17, SDK Android, Node ≥ 20.

```bash
cd app
npm install
npm run keystore     # une seule fois — voir l'avertissement ci-dessous
npm run prebuild
npm run apk
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

APK plus léger, pour un téléphone récent (ARM 64 bits, soit tout appareil
d'après 2019) — divise le poids par deux environ :

```bash
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

> **Conserver `app/credentials/release.keystore` et son mot de passe.**
> Android refuse de mettre à jour une application signée par une autre clé. Si
> ce fichier est perdu, la seule issue est de désinstaller l'app — et donc de
> perdre sa configuration locale — avant de réinstaller.

Au premier lancement, saisir l'adresse du serveur et le jeton d'API.

---

## Exploitation

```bash
docker compose logs -f --tail 100      # journaux
docker compose restart                 # après modification du .env
docker compose exec mrr node -e "fetch('http://127.0.0.1:8791/health').then(r=>r.json()).then(console.log)"
```

**Sauvegarde** — toutes les données tiennent dans un fichier SQLite :

```bash
docker compose exec mrr sh -c "sqlite3 /data/mrr.db '.backup /tmp/b.db'" \
  && docker compose cp mrr:/tmp/b.db ./sauvegarde-$(date +%F).db
```

La base est reconstructible depuis Stripe (`npm run backfill -- --force`), mais
une sauvegarde évite de rejouer 24 mois d'historique.

**Réconciliation** — automatique toutes les heures. Manuellement depuis l'app :
*Réglages → Resynchroniser avec Stripe*.

---

## Développement local

```bash
cd server
cp .env.example .env       # mettre DEMO_MODE=true et vider PROJECTS
npm install
npm run seed -- --reset    # 8 projets fictifs, 24 mois d'historique
npm run dev
```

```bash
cd app && npm install && npx expo start
```

Depuis l'émulateur Android, le serveur de la machine hôte est joignable à
`http://10.0.2.2:8791`.

Les notifications push ne fonctionnent pas dans Expo Go depuis le SDK 53 : il
faut un build de développement ou l'APK release.

---

## Métriques calculées

| Métrique | Définition |
|---|---|
| MRR | Somme des abonnements `active` et `past_due`, chaque périodicité ramenée au mois. Les essais sont suivis à part. |
| ARR | MRR × 12 |
| Ce mois / Depuis janvier | Encaissements réels, remboursements déduits |
| Comparaison M-1 | À périmètre égal : même nombre de jours écoulés le mois précédent |
| Projection fin d'année | Encaissé + MRR sur les mois restants + moyenne du ponctuel sur 90 jours |
| Mouvement du MRR | Nouveaux, expansion, contraction, attrition — leur somme explique la variation du mois |

Les montants multi-devises sont convertis dans `BASE_CURRENCY` avec des taux
rafraîchis quotidiennement (Frankfurter, sans clé d'API).
