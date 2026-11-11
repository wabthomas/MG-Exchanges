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

### Identité et sessions

- **Refus par défaut** : toute route exige une authentification, sauf celles explicitement
  déclarées publiques. Un test compare la liste des routes publiques à une liste fermée :
  en ouvrir une de plus exige de la modifier.
- **Mots de passe** : jamais stockés. Empreinte Argon2id (19 Mio, 2 passes au minimum en
  pré-production et en production — la configuration refuse moins), salée, au format PHC ;
  recalculée à la connexion lorsque les paramètres sont renforcés. Règles de choix conformes
  à NIST SP 800-63B : longueur, pas de règle de composition, refus des mots de passe
  courants, répétitifs ou dérivés de l'identifiant.
- **Jetons de session opaques** (256 bits d'aléa) : seule leur empreinte SHA-256 est stockée.
  Ils ne contiennent aucune information et ne peuvent être ni forgés, ni prolongés — il
  n'existe aucune clé de signature dont le vol permettrait d'usurper un compte. Chaque
  requête vérifie l'état réel de la session et du compte : déconnexion, changement de mot de
  passe et suspension prennent effet immédiatement.
- **Renouvellement avec détection de vol** : le jeton de renouvellement change à chaque
  usage ; la réutilisation d'un jeton déjà remplacé révoque la session entière.
- **Codes à usage unique** : jamais stockés ni transmis en clair entre composants (le code
  est tiré au sort au moment de l'envoi) ; empreinte par HMAC avec une clé absente de la base ;
  5 essais, 15 minutes, 3 codes par quart d'heure et par compte ; un seul code valable à la fois.
- **Aucune divulgation de l'existence d'un compte** : inscription, renvoi de code, mot de
  passe oublié et échec de connexion répondent de la même façon que le compte existe ou non ;
  le coût de calcul est le même dans les deux cas (hachage ou vérification factice).
- **Blocage temporaire** après des échecs de connexion répétés, par (compte, adresse) puis
  par compte ; les compteurs portent sur l'identifiant présenté, existant ou non.
- **Changement de mot de passe** : exige le mot de passe actuel (une session volée ne suffit
  pas), ferme les autres sessions, prévient le titulaire. La réinitialisation ferme toutes
  les sessions.
- **Autorisations** : permissions relues en base à chaque requête d'administration — le
  retrait d'un rôle est immédiat. Tout refus est inscrit au journal d'audit.
- **Aucune élévation de privilège par l'API** : le rôle PostgreSQL de l'API ne peut pas
  écrire dans les tables de rôles et de permissions. Le premier administrateur est créé en
  ligne de commande, avec le rôle propriétaire de la base, et l'opération est tracée.
- **Boîte de réception de développement** : interdite en pré-production et en production par
  la validation de la configuration.

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

| Sujet                                                                                    | Phase |
| ---------------------------------------------------------------------------------------- | ----- |
| Second facteur (TOTP, codes de secours), ré-authentification pour les actions sensibles  | 2     |
| Vérification du téléphone ; détection de connexion inhabituelle et alerte au titulaire   | 2     |
| Attribution des rôles et suspension des comptes depuis le back-office, double validation | 2     |
| Vérification des mots de passe contre les fuites connues                                 | 2     |
| Purge des inscriptions jamais vérifiées, des sessions et des codes expirés               | 2     |
| Chiffrement applicatif des données personnelles sensibles (KYC), rotation des clés       | 2     |
| Protection CSRF du client web (les jetons y seront portés par un cookie `HttpOnly`)      | 7     |
| Idempotence des opérations financières, contrôle de concurrence du grand livre           | 3     |
| Webhooks signés, protection contre le rejeu                                              | 4     |
| Gestion des clés blockchain hors de l'application (HSM / KMS), politiques de signature   | 5     |
| Surveillance des transactions, plafonds, filtrage, dossiers de conformité                | 8     |
| TLS de bout en bout, sauvegardes chiffrées, restauration testée, alertes                 | 9     |
| Analyse de vulnérabilités des images, tests d'intrusion                                  | 9     |

## Signaler une vulnérabilité

Ne pas ouvrir de ticket public. Le canal de signalement sera publié avant toute mise en
service ; d'ici là, contacter directement le propriétaire du dépôt.
