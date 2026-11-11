# Sécurité

Ce document distingue strictement ce qui est **en place et testé** de ce qui est **prévu**.
Rien de ce qui figure dans la seconde catégorie ne doit être considéré comme acquis.

## En place (phase 1)

### Configuration et secrets

- Aucun secret dans le dépôt : seuls des modèles `*.env.example` sans valeur sont versionnés ;
  `.env`, clés et certificats sont exclus par `.gitignore`.
- La configuration est validée au démarrage ; un message d'erreur de configuration ne
  contient jamais la valeur d'une variable.
- En production, la configuration provient uniquement de l'environnement du processus
  (gestionnaire de secrets de la plateforme d'hébergement) ; aucun fichier `.env` n'est lu.
- Règles durcies en `staging` et `production`, vérifiées au démarrage : `NODE_ENV=production`,
  journaux JSON, pas de joker CORS, documentation de l'API fermée en production.

### Journaux et audit

- Journalisation structurée avec **expurgation systématique** : toute clé au nom sensible
  (`password`, `token`, `secret`, `authorization`, `cookie`, `otp`, `pin`, `privateKey`,
  `mnemonic`, `cardNumber`…) et tout jeton reconnaissable (`Bearer …`, JWT) sont remplacés
  par `[REDACTED]`, à toute profondeur.
- D'une requête HTTP ne sont journalisés que la méthode, le chemin (sans la chaîne de
  requête), l'adresse du client et l'agent utilisateur — ni en-têtes, ni corps.
- Journal d'audit en ajout seul, protégé par la base elle-même (voir `DATABASE.md`) ;
  ses métadonnées sont expurgées avant écriture ; l'entrée d'audit est écrite dans la
  transaction de l'opération auditée.

### Surface HTTP

- En-têtes de sécurité sur toutes les réponses : `Content-Security-Policy` (dont
  `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `Strict-Transport-Security` (2 ans),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` ; `X-Powered-By` supprimé.
- `Cache-Control: no-store` sur toutes les réponses.
- CORS : liste d'origines explicite ; aucune origine autorisée par défaut.
- API JSON uniquement : les corps de formulaire ne sont pas interprétés, ce qui écarte les
  requêtes inter-sites forgées par un simple formulaire. Taille du corps bornée.
- Validation systématique des entrées par schéma ; propriétés inconnues refusées.
- Erreurs : une erreur inattendue renvoie un message générique ; pile d'appels et message
  interne restent dans les journaux, rattachés à l'identifiant de requête.
- Limitation de débit par adresse IP, compteurs atomiques partagés dans Redis. **Fermée en
  cas de panne** : si Redis est indisponible, la requête échoue plutôt que de passer sans contrôle.
- Adresse du client : `X-Forwarded-For` n'est pris en compte que pour le nombre de proxys de
  confiance configuré (`TRUST_PROXY_HOPS`) ; Nginx écrase la valeur fournie par le client.
- La sonde de disponibilité n'indique que l'état de chaque dépendance (ni adresse, ni version,
  ni message d'erreur) et n'est pas relayée par Nginx.

### Base de données

- Séparation des rôles : l'API se connecte avec un rôle sans aucun droit sur le schéma, ni
  aucun accès à l'historique des migrations.
- Requêtes paramétrées exclusivement (client Prisma, gabarits `Prisma.sql`) : aucune
  concaténation de SQL avec une entrée utilisateur.
- Délai maximal d'exécution par requête ; taille du pool bornée.

### Fonctionnalités réglementées

- Toute fonctionnalité (inscription, KYC, dépôts, retraits, échange, P2P, transferts) est
  **désactivée par défaut**. L'ouvrir exige une modification de paramètre, tracée dans le
  journal d'audit avec son auteur et sa justification.
- Une valeur de paramètre corrompue en base est ignorée au profit de l'état fermé.
- La disponibilité technique d'une fonctionnalité ne vaut pas autorisation légale : les
  exigences réglementaires de chaque pays doivent être établies avant toute ouverture.

### Chaîne d'approvisionnement

- Versions exactes épinglées (catalogue pnpm) et fichier de verrouillage figé en CI.
- Une version publiée depuis moins de 3 jours n'est jamais installée.
- Scripts d'installation des dépendances refusés par défaut ; liste d'autorisation explicite
  et commentée dans `pnpm-workspace.yaml`.
- `pnpm audit` en CI ; actions GitHub épinglées par empreinte de commit ; permissions
  minimales du jeton de CI.

### Conteneurs

- Images d'exécution et de migration : utilisateur non privilégié ; l'image d'exécution ne
  contient que le code compilé et les dépendances de production.
- Compose : système de fichiers en lecture seule, toutes les capacités retirées,
  `no-new-privileges` ; PostgreSQL et Redis ne sont publiés que sur l'interface locale.

### Garde-fous dans le code

- ESLint interdit `parseFloat` et `toFixed` : aucun montant ne passe par un nombre flottant.
- Les frontières d'architecture sont vérifiées statiquement.

## Prévu — non réalisé à ce jour

| Sujet                                                                                   | Phase |
| --------------------------------------------------------------------------------------- | ----- |
| Authentification : Argon2id, JWT de courte durée, jetons de rafraîchissement à rotation | 2     |
| MFA, gestion des appareils et des sessions, détection de connexion inhabituelle         | 2     |
| Blocage temporaire et limites de débit dédiées (connexion, codes à usage unique)        | 2     |
| RBAC (puis ABAC), double validation des opérations d'administration sensibles           | 2     |
| Chiffrement applicatif des données personnelles sensibles, rotation des clés            | 2     |
| Protection CSRF (selon le mode de transport des jetons retenu)                          | 2     |
| Idempotence des opérations financières, contrôle de concurrence du grand livre          | 3     |
| Webhooks signés, protection contre le rejeu                                             | 4     |
| Gestion des clés blockchain hors de l'application (HSM / KMS), politiques de signature  | 5     |
| Surveillance des transactions, plafonds, filtrage, dossiers de conformité               | 8     |
| TLS de bout en bout, sauvegardes chiffrées, restauration testée, alertes                | 9     |
| Analyse de vulnérabilités des images, tests d'intrusion                                 | 9     |

## Signaler une vulnérabilité

Ne pas ouvrir de ticket public. Le canal de signalement sera publié avant toute mise en
service ; d'ici là, contacter directement le propriétaire du dépôt.
