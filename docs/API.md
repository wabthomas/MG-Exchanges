# API

Le contrat exact est le document OpenAPI [`docs/api/openapi.json`](api/openapi.json),
généré à partir du code et vérifié par les tests (importable dans Postman, Insomnia, Bruno).
En développement, il est consultable de façon interactive sur `/api/docs`.

## Conventions

| Sujet            | Règle                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Base             | `/api/v{n}/…` — la version figure dans le chemin ; chaque contrôleur déclare la sienne                                                      |
| Format           | JSON uniquement (`Content-Type: application/json`) ; les formulaires ne sont pas interprétés                                                |
| Fichiers         | une seule route en reçoit — l'envoi d'une pièce de vérification : le fichier est le corps                                                   |
| Montants         | chaînes décimales canoniques (`"12.34"`), **jamais** des nombres JSON                                                                       |
| Horodatages      | ISO 8601 en UTC (`2026-01-31T12:00:00.000Z`)                                                                                                |
| Identifiants     | UUID                                                                                                                                        |
| Authentification | `Authorization: Bearer <jeton d'accès>` sur **toute** route, sauf celles dites publiques                                                    |
| Entrées          | validées par schéma ; les propriétés inconnues sont refusées                                                                                |
| Cache            | `Cache-Control: no-store` sur toutes les réponses                                                                                           |
| Taille du corps  | 100 Ko par défaut (`HTTP_BODY_LIMIT_BYTES`) ; 5 Mio pour une pièce de vérification ; 1 Mio pour la publication des conditions d'utilisation |

### Identifiant de requête

Chaque réponse porte l'en-tête `X-Request-Id`. Un identifiant fourni par l'appelant est
repris s'il respecte le format (8 à 128 caractères : lettres, chiffres, `.`, `_`, `-`) ;
sinon l'API en génère un. Il figure dans les journaux et dans le corps des erreurs : c'est
la référence à communiquer au support. Derrière le reverse proxy, l'identifiant est attribué
par Nginx (celui de l'appelant est alors ignoré) et se retrouve dans les journaux des deux.

### Limitation de débit

Limite globale par adresse IP (120 requêtes par minute par défaut). En-têtes de réponse :
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (secondes). Au-delà :
`429` avec l'en-tête `Retry-After`. Les routes sensibles appliqueront des limites dédiées.

## Erreurs

Toutes les erreurs ont la même forme — « Problem Details » (RFC 9457),
`Content-Type: application/problem+json` :

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "code": "VALIDATION_FAILED",
  "detail": "Request validation failed.",
  "instance": "/api/v1/example",
  "requestId": "0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d",
  "timestamp": "2026-01-31T12:00:00.000Z",
  "errors": [{ "path": "amount", "message": "Must be a canonical decimal string, e.g. \"12.34\"." }]
}
```

Les clients se fondent sur **`code`** — stable, jamais renommé — et non sur le texte, pour
décider du comportement et de la traduction affichée. `errors` n'est présent que pour les
erreurs de validation. Une erreur serveur ne révèle jamais de détail interne.

| Code                        | Statut | Signification                                                                 |
| --------------------------- | ------ | ----------------------------------------------------------------------------- |
| `VALIDATION_FAILED`         | 400    | entrée invalide (détail dans `errors`)                                        |
| `MALFORMED_REQUEST`         | 400    | requête illisible (JSON mal formé…)                                           |
| `INVALID_OR_EXPIRED_CODE`   | 400    | code à usage unique refusé, quelle qu'en soit la cause                        |
| `UNAUTHENTICATED`           | 401    | jeton d'accès absent, invalide ou expiré                                      |
| `INVALID_CREDENTIALS`       | 401    | identifiant ou mot de passe erroné (sans préciser lequel)                     |
| `FORBIDDEN`                 | 403    | action non autorisée                                                          |
| `FEATURE_DISABLED`          | 403    | fonctionnalité non ouverte                                                    |
| `EMAIL_NOT_VERIFIED`        | 403    | mot de passe correct, adresse e-mail non vérifiée                             |
| `ACCOUNT_DISABLED`          | 403    | mot de passe correct, compte suspendu                                         |
| `MFA_ENROLLMENT_REQUIRED`   | 403    | back-office : la validation en deux étapes doit d'abord être activée          |
| `TERMS_ACCEPTANCE_REQUIRED` | 403    | la version en vigueur des conditions d'utilisation doit d'abord être acceptée |
| `NOT_FOUND`                 | 404    | ressource ou route inexistante                                                |
| `METHOD_NOT_ALLOWED`        | 405    |                                                                               |
| `NOT_ACCEPTABLE`            | 406    |                                                                               |
| `REQUEST_TIMEOUT`           | 408    | le corps de la requête a mis trop de temps à arriver                          |
| `CONFLICT`                  | 409    | conflit avec l'état actuel                                                    |
| `TERMS_VERSION_NOT_CURRENT` | 409    | la version des conditions désignée n'est pas — ou plus — celle en vigueur     |
| `PAYLOAD_TOO_LARGE`         | 413    | corps trop volumineux                                                         |
| `UNSUPPORTED_MEDIA_TYPE`    | 415    | type de contenu non accepté (envoi d'une pièce, publication des conditions)   |
| `UNPROCESSABLE_ENTITY`      | 422    | requête comprise mais refusée par une règle métier                            |
| `COUNTRY_NOT_SUPPORTED`     | 422    | pays de résidence non desservi                                                |
| `RATE_LIMITED`              | 429    | trop de requêtes (voir `Retry-After`)                                         |
| `INTERNAL_ERROR`            | 500    | erreur inattendue                                                             |
| `MAINTENANCE`               | 503    | plateforme en maintenance                                                     |
| `SERVICE_UNAVAILABLE`       | 503    | service momentanément indisponible                                            |

Le catalogue fait foi dans `packages/contracts/src/errors/error-codes.ts`.

### Erreurs produites par le reverse proxy

Nginx répond lui-même dans cinq cas, **au même format** que l'API :

| Cas                                                                                                                 | Réponse                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| route non relayée vers l'API                                                                                        | `404 NOT_FOUND`                             |
| corps de plus de 128 Ko (6 Mio pour l'envoi d'une pièce, 1 100 Ko pour la publication des conditions d'utilisation) | `413 PAYLOAD_TOO_LARGE`                     |
| limitation de débit amont dépassée                                                                                  | `429 RATE_LIMITED`, `Retry-After: 1`        |
| plus de quatre envois de pièces simultanés depuis une adresse                                                       | `429 RATE_LIMITED`, `Retry-After: 1`        |
| API injoignable, arrêtée ou trop lente                                                                              | `503 SERVICE_UNAVAILABLE`, `Retry-After: 5` |

Un test (`nginx-problem-details.spec.ts`) vérifie que la configuration du proxy respecte le
contrat. Seules les erreurs de protocole détectées avant tout traitement (requête HTTP mal
formée, en-têtes trop volumineux) conservent la page par défaut de Nginx.

## Points d'accès

### `GET /api/v1/system/status`

Public. Ce qu'un client doit savoir au démarrage. Reste accessible en mode maintenance.

```json
{
  "service": "mg-exchange-api",
  "version": "0.1.0",
  "serverTime": "2026-11-11T15:31:53.171Z",
  "maintenance": { "enabled": false, "message": null },
  "features": {
    "registration": false,
    "kyc": false,
    "internalTransfers": false,
    "fiatDeposits": false,
    "fiatWithdrawals": false,
    "cryptoDeposits": false,
    "cryptoWithdrawals": false,
    "exchange": false,
    "p2p": false
  }
}
```

Erreurs : `429`, `500`.

### Sondes (hors préfixe `/api`, non versionnées, non limitées)

| Route               | Réponse                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `GET /health/live`  | `200 {"status":"ok"}` — le processus répond                                   |
| `GET /health/ready` | `200` si PostgreSQL et Redis sont joignables, sinon `503 SERVICE_UNAVAILABLE` |

`/health/ready` n'est pas exposée par Nginx : elle est réservée à l'orchestrateur.

## Mode maintenance et fonctionnalités

En mode maintenance, toute route répond `503 MAINTENANCE` (le message saisi par
l'administration figure dans `detail`), sauf : l'état de la plateforme, les sondes, la
connexion (seconde étape comprise), le renouvellement et la fermeture de session,
`GET /api/v1/me`, la gestion de la validation en deux étapes (`/api/v1/me/mfa/…`), la lecture
des conditions d'utilisation (`/api/v1/terms/…`) et tout le back-office (`/api/v1/admin/…`) —
c'est par lui qu'on sort de la maintenance, et un compte compromis doit pouvoir être suspendu
à tout moment.
Une route rattachée à une fonctionnalité fermée répond `403 FEATURE_DISABLED`.

## Authentification et sessions

**Refus par défaut.** Toute route exige un jeton d'accès, sauf celles explicitement
publiques : état de la plateforme, sondes, lecture des conditions d'utilisation, inscription,
vérification de l'adresse, connexion et sa seconde étape, renouvellement, mot de passe oublié.
Sans jeton valide : `401 UNAUTHENTICATED`.

**Jetons.** Une connexion ouvre une session et renvoie deux jetons opaques :

| Jeton                   | Forme      | Durée                                   | Usage                                      |
| ----------------------- | ---------- | --------------------------------------- | ------------------------------------------ |
| jeton d'accès           | `mgx_at_…` | 10 minutes                              | `Authorization: Bearer …` à chaque requête |
| jeton de renouvellement | `mgx_rt_…` | 14 jours d'inactivité, 60 jours au plus | `POST /api/v1/auth/refresh` uniquement     |

Le jeton de renouvellement **change à chaque utilisation** : le client conserve toujours le
dernier reçu. Présenter un jeton déjà remplacé révoque la session entière (il a été copié),
sauf dans les 10 secondes qui suivent son utilisation — tolérance à une réponse perdue sur un
réseau instable. Fermer une session, changer de mot de passe ou suspendre un compte prend
effet **immédiatement**, y compris sur les jetons d'accès en circulation.

Un client web conserve les jetons côté serveur (ou dans un cookie `HttpOnly`), jamais dans
un stockage accessible au JavaScript ; un client mobile utilise le stockage sécurisé du système.

### Inscription

Fermée tant que la fonctionnalité `registration` n'est pas ouverte (`403 FEATURE_DISABLED`),
et tant qu'aucune version des conditions d'utilisation n'est publiée
(`503 SERVICE_UNAVAILABLE`) : on n'ouvre pas de compte sans texte à accepter.

| Route                            | Corps                                                                           | Réponse                                              |
| -------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `POST /api/v1/auth/register`     | `email`, `password`, `countryCode`, `acceptedTermsVersion`, `phone?`, `locale?` | `202` `{ nextStep: "VERIFY_EMAIL", codeTtlSeconds }` |
| `POST /api/v1/auth/email/verify` | `email`, `code` (6 chiffres), `password`                                        | `204`                                                |
| `POST /api/v1/auth/email/resend` | `email`                                                                         | `202`, même corps que l'inscription                  |

- **S'inscrire, c'est accepter les conditions d'utilisation en vigueur.**
  `acceptedTermsVersion` est le numéro (`number`) de la version que la personne a eue sous
  les yeux — celle rendue par `GET /api/v1/terms/current`. Si ce n'est pas, ou plus, la
  version en vigueur : `409 TERMS_VERSION_NOT_CURRENT` — relire la version en vigueur,
  l'afficher, recommencer. L'acceptation est enregistrée avec le compte, et datée par la base.
- Le compte ne peut pas se connecter avant la vérification de l'adresse.
- **La vérification exige le code _et_ le mot de passe choisi à l'inscription**
  (`401 INVALID_CREDENTIALS` s'il est erroné) : celui qui a rempli le formulaire et celui qui
  lit la boîte aux lettres doivent être la même personne. Sans cela, n'importe qui pourrait
  préparer un compte à l'adresse d'autrui et attendre que son titulaire l'active.
- **S'inscrire à nouveau avec une adresse non encore vérifiée remplace l'inscription
  précédente** — mot de passe, pays, langue, acceptation des conditions (celle du précédent
  demandeur est effacée) : seul le dernier mot de passe saisi permettra la vérification.
- Une inscription dont l'adresse n'est pas vérifiée dans les **7 jours** est supprimée.
- Mot de passe : 10 à 128 caractères, aucune règle de composition ; sont refusés les mots de
  passe trop courants, trop répétitifs ou dérivés de l'adresse ou du téléphone.
- Pays desservi au lancement : `CD`. Tout autre pays : `422 COUNTRY_NOT_SUPPORTED`.
- Un code est valable 15 minutes et peut être essayé 5 fois ; au plus 3 codes par quart
  d'heure et par compte. Tout refus répond `400 INVALID_OR_EXPIRED_CODE`, sans en préciser la cause.

**Aucune réponse ne révèle l'existence d'un compte.** S'inscrire avec une adresse déjà prise,
demander un renvoi de code ou une réinitialisation pour une adresse inconnue : la réponse est
identique dans tous les cas. Le titulaire d'un compte existant est, lui, prévenu par e-mail.

### Connexion et session

| Route                                    | Auth. | Corps                                           | Réponse                                                                      |
| ---------------------------------------- | ----- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `POST /api/v1/auth/login`                | non   | `email`, `password`, `deviceName?`, `deviceId?` | `200` — voir `status` ci-dessous                                             |
| `POST /api/v1/auth/mfa/verify`           | non   | `mfaToken`, et `code` **ou** `recoveryCode`     | `200` `{ status, tokens, sessionId, user }`                                  |
| `POST /api/v1/auth/refresh`              | non   | `refreshToken`                                  | `200` `{ tokens }`                                                           |
| `POST /api/v1/auth/logout`               | oui   | —                                               | `204`                                                                        |
| `GET /api/v1/me`                         | oui   | —                                               | compte, rôles, permissions, `secondFactorEnabled`, `termsAcceptanceRequired` |
| `GET /api/v1/me/sessions`                | oui   | —                                               | sessions ouvertes (« mes appareils »)                                        |
| `DELETE /api/v1/me/sessions/{sessionId}` | oui   | —                                               | `204`                                                                        |
| `POST /api/v1/me/sessions/revoke-others` | oui   | —                                               | `200` `{ revoked }`                                                          |

La réponse de `POST /auth/login` se lit par son champ **`status`** (d'autres valeurs pourront
s'ajouter sans changement de version) :

| `status`        | Signification                                           | Corps                                                    |
| --------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| `AUTHENTICATED` | session ouverte                                         | `tokens`, `sessionId`, `user`                            |
| `MFA_REQUIRED`  | mot de passe correct, **aucune session encore ouverte** | `mfaToken` (`mgx_mfa_…`), `mfaTokenExpiresAt`, `methods` |

Sur `MFA_REQUIRED`, présenter `mfaToken` à `POST /auth/mfa/verify` avec le code à six chiffres
de l'application d'authentification (`code`) ou un code de secours (`recoveryCode`). Le jeton
vaut 5 minutes, 5 présentations et une seule connexion ; il n'ouvre aucun droit par lui-même.
Un code refusé répond `400 INVALID_OR_EXPIRED_CODE` ; un jeton expiré, épuisé ou annulé,
`401 UNAUTHENTICATED` (reprendre à `POST /auth/login`).

- **`deviceId`** (facultatif, 16 à 128 caractères `A-Z a-z 0-9 _ -`) : valeur aléatoire créée
  par l'application à son installation et conservée sur l'appareil. Elle permet de reconnaître
  un appareil déjà utilisé ; une connexion depuis un appareil inconnu est signalée au titulaire
  par e-mail. Sans elle, l'agent utilisateur sert de repère. Seule son empreinte est conservée.
- Adresse inconnue et mot de passe erroné reçoivent la même réponse : `401 INVALID_CREDENTIALS`.
- **Blocage temporaire** : 5 échecs en 15 minutes bloquent ce client (compte + adresse IP)
  15 minutes ; 20 échecs en une heure bloquent le compte une heure pour tous. Réponse :
  `429 RATE_LIMITED` avec `Retry-After`. Pendant le blocage, même le bon mot de passe est refusé.
- `EMAIL_NOT_VERIFIED` et `ACCOUNT_DISABLED` ne sont renvoyés qu'à qui présente le bon mot de passe.
- `user.termsAcceptanceRequired` (réponse de connexion, `GET /me`) vaut `true` si le compte
  doit accepter la version en vigueur des conditions d'utilisation avant de continuer : la
  connexion aboutit, mais la plupart des routes du compte lui sont fermées jusque-là — voir
  « Conditions d'utilisation ».
- Un compte **clôturé** n'existe plus pour la connexion : son ancienne adresse reçoit
  `401 INVALID_CREDENTIALS`, comme une adresse inconnue — jusqu'à ce qu'un nouveau compte
  l'utilise.

### Mot de passe

| Route                               | Auth. | Corps                            | Réponse                                                |
| ----------------------------------- | ----- | -------------------------------- | ------------------------------------------------------ |
| `POST /api/v1/auth/password/forgot` | non   | `email`                          | `202` `{ nextStep: "RESET_PASSWORD", codeTtlSeconds }` |
| `POST /api/v1/auth/password/reset`  | non   | `email`, `code`, `newPassword`   | `204` — **toutes** les sessions sont fermées           |
| `POST /api/v1/auth/password/change` | oui   | `currentPassword`, `newPassword` | `204` — les **autres** sessions sont fermées           |

Le titulaire est prévenu par e-mail de tout changement de mot de passe.

- Réinitialiser le mot de passe **ne retire pas** la validation en deux étapes : l'accès à la
  boîte aux lettres ne suffit pas à entrer dans un compte protégé.
- Seul un compte **actif** se réinitialise. Pour une inscription non vérifiée, la réponse est
  la même (`202`) mais le message reçu invite à reprendre l'inscription ; un compte suspendu
  ne reçoit rien.

### Validation en deux étapes (TOTP)

Application d'authentification standard (RFC 6238 : SHA-1, 6 chiffres, 30 secondes). Toutes
ces routes exigent une session ; celles qui modifient le second facteur exigent en plus de
**présenter à nouveau le mot de passe**.

| Route                                | Corps                                              | Réponse                                                          |
| ------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/v1/me/mfa`                 | —                                                  | `{ totp: { enabled, enabledAt }, recoveryCodesRemaining }`       |
| `POST /api/v1/me/mfa/totp/enroll`    | `currentPassword`                                  | `200` `{ secret, otpauthUri, algorithm, digits, periodSeconds }` |
| `POST /api/v1/me/mfa/totp/confirm`   | `code`                                             | `200` `{ recoveryCodes: [10 codes] }`                            |
| `POST /api/v1/me/mfa/totp/disable`   | `currentPassword`, et `code` **ou** `recoveryCode` | `204`                                                            |
| `POST /api/v1/me/mfa/recovery-codes` | `currentPassword`, `code`                          | `200` `{ recoveryCodes: [10 codes] }`                            |

- **Activation en deux temps.** `enroll` remet le secret (à afficher en QR code avec
  `otpauthUri`, ou à saisir) — une seule fois. Rien n'est exigé à la connexion tant qu'un
  premier code n'a pas été confirmé, dans les **30 minutes** (`409 CONFLICT` au-delà : recommencer).
- **Codes de secours.** Dix codes `ABCDE-12345`, remis **une seule fois** à la confirmation ;
  chacun remplace une fois le code de l'application. La saisie est tolérante (minuscules,
  espaces, tiret omis). Leur utilisation est signalée au titulaire par e-mail.
- **Effets.** Activer, désactiver ou faire retirer le second facteur ferme les **autres**
  sessions du compte et prévient le titulaire par e-mail.
- **Un code ne sert qu'une fois**, même dans sa fenêtre de validité.
- **Blocage.** 5 codes erronés en 15 minutes bloquent la seconde étape du compte 15 minutes ;
  20 en 24 heures, 24 heures — d'où que viennent les essais, et sans qu'une connexion réussie
  n'efface le second compteur. Réponse : `429 RATE_LIMITED` avec `Retry-After` ; le titulaire
  est prévenu (quelqu'un connaît son mot de passe). 5 mots de passe erronés en 15 minutes
  bloquent de même les opérations sensibles du compte.
- **Perte du téléphone et des codes de secours :** seul le support peut retirer le second
  facteur (voir « Administration »).

### Profil, téléphone et historique

| Route                                | Corps             | Réponse                                              |
| ------------------------------------ | ----------------- | ---------------------------------------------------- |
| `GET /api/v1/me/profile`             | —                 | profil                                               |
| `PATCH /api/v1/me/profile`           | champs à modifier | profil                                               |
| `POST /api/v1/me/phone/verification` | `phone`           | `202` `{ nextStep: "VERIFY_PHONE", codeTtlSeconds }` |
| `POST /api/v1/me/phone/verify`       | `code`            | `204`                                                |
| `GET /api/v1/me/activity`            | `?limit=&before=` | `{ entries, nextCursor }`                            |

- **Profil.** `givenName`, `familyName`, `additionalName` (postnom), `dateOfBirth`
  (`AAAA-MM-JJ`, 18 ans révolus), `addressLine1`, `addressLine2`, `city`, `region`,
  `postalCode`, `locale` (`fr` \| `en`), `timeZone` (IANA, ex. `Africa/Kinshasa`). La
  modification est partielle : seuls les champs présents changent, `null` efface (sauf
  `locale`). Ces informations sont **déclarées** tant que la vérification d'identité ne les a
  pas établies. Une fois l'identité vérifiée (`identityVerified`), les noms, la date et le
  lieu de naissance (`placeOfBirth`) et la nationalité (`nationality`) sont ceux de la pièce ;
  une fois l'adresse vérifiée (`addressVerified`), l'adresse est celle du justificatif.
  Modifier un champ vérifié répond `409 CONFLICT` (champs en cause dans `errors`) : en changer
  passe par un nouveau dossier de vérification.
- **Téléphone.** Un code à six chiffres est envoyé par SMS ; le numéro ne devient celui du
  compte **qu'une fois confirmé** — jusque-là, un numéro déjà vérifié reste en place. Seuls
  les mobiles des pays desservis sont acceptés (RDC : `+243 8x…` et `9x…` ;
  `422 COUNTRY_NOT_SUPPORTED` sinon). Au plus 3 SMS par quart d'heure et par compte, 3 par
  heure et par numéro. Un numéro vérifié n'appartient qu'à un compte : la confirmation répond
  `409 CONFLICT` s'il l'est déjà ailleurs — ce que seul le détenteur du numéro peut apprendre.
- **Historique.** Événements de sécurité du compte, du plus récent au plus ancien : connexions
  (y compris échouées), mot de passe, second facteur, profil, téléphone, vérification
  d'identité (dépôt, acceptation, refus, retrait), acceptation des conditions d'utilisation
  (`TERMS_ACCEPTED`), interventions du support. La liste des
  types est fermée (`type`) ; chaque entrée porte `occurredAt`, `outcome`, et l'adresse IP et
  l'appareil d'origine — sauf pour une intervention du personnel. Ce qu'un membre du
  personnel fait au compte d'un client figure dans l'historique de ce client, pas dans le sien.
  Pagination par curseur : `before` = `nextCursor` de la page précédente ; `limit` ≤ 100.

### Copie des données et clôture du compte

| Route                         | Corps                                                  | Réponse                                                 |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `POST /api/v1/me/data-export` | `currentPassword`, `code` \| `recoveryCode`            | `200` la copie (JSON, proposée en téléchargement)       |
| `POST /api/v1/me/close`       | `currentPassword`, `code` \| `recoveryCode`, `confirm` | `200` `{ closedAt, legalRetentionUntil, erasureDueAt }` |

- **Preuve du titulaire.** Une session ouverte ne suffit pas : ces deux routes exigent de
  nouveau le mot de passe (`currentPassword`) et — **si** la validation en deux étapes est
  activée sur le compte — `code` (application d'authentification) **ou** `recoveryCode` (code
  de secours, consommé). Mot de passe erroné : `401 INVALID_CREDENTIALS` ; second facteur
  attendu mais absent : `422 UNPROCESSABLE_ENTITY` ; code refusé :
  `400 INVALID_OR_EXPIRED_CODE` ; les deux à la fois : `400 VALIDATION_FAILED`. Les essais
  erronés sont comptés comme ailleurs (`429 RATE_LIMITED` avec `Retry-After`) et inscrits à
  l'historique du compte.
- **Copie des données.** Un document JSON (`Content-Disposition: attachment`,
  `mg-exchange-data.json`) : `formatVersion` (`2`), `generatedAt`, `account`, `profile`,
  `security`, `sessions`, `activity` (les 2 000 événements les plus récents ; `truncated`
  indique s'il en existe de plus anciens), `verification` (niveau et dossiers) et `terms`
  (`acceptances` : chaque version des conditions d'utilisation acceptée et sa date, de la
  plus récente à la plus ancienne). Le format `2` a ajouté `terms` et retiré
  `account.termsAcceptedAt`. Elle ne
  contient **aucun secret** ; le numéro d'une pièce d'identité y est masqué ; les fichiers
  joints aux dossiers y sont **décrits, pas inclus**. Au plus **3 copies par 24 heures**
  (`429` ensuite). Chaque copie figure dans l'historique et est signalée au titulaire par
  e-mail, avec l'adresse IP d'origine. `503 SERVICE_UNAVAILABLE` si le compte a déclaré une
  pièce d'identité alors que le stockage chiffré n'est pas configuré côté serveur.
- **Clôture.** `confirm` doit valoir `true`. Elle est **immédiate et définitive** :
  - toutes les sessions sont fermées ; mot de passe, second facteur et profil sont effacés ;
    l'ancienne adresse ne permet plus de se connecter ni de réinitialiser un mot de passe ;
  - l'adresse e-mail, le numéro de téléphone et la pièce d'identité sont **libres aussitôt**
    pour une nouvelle inscription — le nouveau compte n'hérite de rien ;
  - un dossier de vérification jamais examiné (en préparation ou déposé) est effacé avec ses
    pièces ; ceux sur lesquels une décision a été prise sont conservés jusqu'à
    `legalRetentionUntil` (dix ans après la clôture ; `null` s'il n'y en a pas) ;
  - ce qui reste — l'ancienne adresse, l'ancien numéro, les dossiers conservés — est effacé à
    partir de `erasureDueAt` (le terme légal, et jamais moins de 30 jours après la clôture) ;
  - le titulaire reçoit un e-mail de confirmation à son ancienne adresse.

  `409 CONFLICT` si le compte détient un rôle du back-office : il lui est d'abord retiré.
  `409 CONFLICT` aussi, plus rarement, si une autre requête modifie le compte au même instant
  et tarde à s'achever : rien n'a changé, la demande est à refaire.

- Ces deux routes suivent le mode maintenance (`503 MAINTENANCE`) ; le back-office, lui, peut
  toujours clore un compte.
- Elles restent ouvertes à un compte qui n'a pas accepté la version en vigueur des conditions
  d'utilisation : qui refuse un nouveau texte doit pouvoir emporter ses données et partir.

## Conditions d'utilisation

Les conditions d'utilisation sont **versionnées** : chaque version porte un numéro (1, 2, 3…,
sans trou), un texte en français — qui fait foi — et, s'il a été fourni, sa traduction
anglaise, un résumé de ce qui change, et une **règle** fixée à sa publication :

- `requiresAcceptance: true` — chaque compte doit accepter cette version avant de continuer ;
- `requiresAcceptance: false` — elle est seulement signalée comme la version en vigueur : un
  compte qui a accepté une version antérieure n'est pas interrompu.

La version en vigueur est la plus récente. Une version publiée ne change plus jamais et ne se
retire pas : corriger un texte, c'est publier la version suivante. La première version exige
toujours d'être acceptée, et une inscription accepte toujours la version en vigueur, quelle
que soit sa règle.

### Lire les conditions (sans compte)

| Route                                 | Réponse                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/v1/terms/current`           | la version en vigueur et son texte ; `404` tant qu'aucune n'est publiée          |
| `GET /api/v1/terms/versions`          | `{ versions }` — les 100 plus récentes, sans leur texte, la plus récente d'abord |
| `GET /api/v1/terms/versions/{number}` | une version, en vigueur ou passée, et son texte ; `404` si elle n'existe pas     |

- Paramètre `?locale=fr|en` (défaut `fr`). Une version sans traduction dans la langue demandée
  est servie **en français** ; le champ `locale` de la réponse dit quelle langue a été servie,
  `locales` celles qui existent.
- Une version : `number`, `publishedAt`, `requiresAcceptance`, `current`, `locales`, `locale`,
  `summary`, et — hors liste — `body` et `sha256`. Le texte est rendu **tel qu'il a été
  publié, à l'octet près** (texte brut ou Markdown : l'API ne l'interprète pas) ; `sha256` est
  l'empreinte SHA-256 de `body` encodé en UTF-8.
- Ces routes restent ouvertes pendant la maintenance. Au plus 60 lectures par minute et par
  client (`429` ensuite).

### Mon compte et les conditions

| Route                              | Corps     | Réponse                                     |
| ---------------------------------- | --------- | ------------------------------------------- |
| `GET /api/v1/me/terms`             | —         | `{ current, accepted, acceptanceRequired }` |
| `POST /api/v1/me/terms/acceptance` | `version` | `200`, même corps                           |

- `current` : la version en vigueur (`number`, `publishedAt`, `requiresAcceptance`), `null`
  tant qu'aucune n'est publiée. `accepted` : la dernière version acceptée par le compte
  (`number`, `acceptedAt`), ou `null`. `acceptanceRequired` : le compte doit accepter la
  version en vigueur avant de continuer.
- **Quand faut-il accepter ?** Dès qu'une version publiée exige d'être acceptée et que le
  compte n'a accepté ni elle, ni une version publiée depuis. Accepter une version, c'est
  accepter le texte en vigueur ce jour-là : il tient lieu de ceux qui l'ont précédé.
- **Accepter.** `version` est le numéro du texte que le titulaire a eu sous les yeux. Ce doit
  être la version en vigueur : sinon `409 TERMS_VERSION_NOT_CURRENT` — relire
  `GET /terms/current`, afficher ce texte, recommencer. On n'accepte pas un texte qu'on n'a
  pas pu lire. Accepter deux fois la même version ne change rien : la première acceptation et
  sa date font foi. Une version « pour information » peut être acceptée, sans obligation.
- L'acceptation est datée par la base, inscrite à l'historique du compte (`TERMS_ACCEPTED`)
  et au journal d'audit avec l'empreinte du texte accepté.
- **Tant que le compte doit accepter**, ses routes répondent
  `403 TERMS_ACCEPTANCE_REQUIRED` — avant même la validation de la requête. Ne lui restent
  ouvertes que :

  | Reste ouvert                            | Routes                                                                            |
  | --------------------------------------- | --------------------------------------------------------------------------------- |
  | voir où il en est, accepter             | `GET /me`, `GET /me/terms`, `POST /me/terms/acceptance`                           |
  | se déconnecter, changer de mot de passe | `POST /auth/logout`, `POST /auth/password/change`                                 |
  | ses sessions                            | `GET /me/sessions`, `DELETE /me/sessions/{id}`, `POST /me/sessions/revoke-others` |
  | la validation en deux étapes            | `/me/mfa/…`                                                                       |
  | son historique                          | `GET /me/activity`                                                                |
  | emporter ses données, partir            | `POST /me/data-export`, `POST /me/close`                                          |

  Lui sont fermés : le profil, le numéro de téléphone, la vérification d'identité — et, par
  défaut, **toute route ajoutée par la suite** (elle doit déclarer explicitement qu'elle reste
  ouverte). Les routes publiques ne sont pas concernées, ni le back-office : le personnel y
  agit pour la plateforme, non comme client.

- Ces deux routes suivent le mode maintenance (`503 MAINTENANCE`).
- Un compte clôturé n'a plus rien à accepter ; la clôture efface ses acceptations, dont la
  trace reste au journal d'audit.

## Vérification d'identité (KYC)

Réservée aux **particuliers**, et à la fonctionnalité `kyc` (`403 FEATURE_DISABLED` tant
qu'elle est fermée — c'est le cas par défaut). `GET /api/v1/me` porte le niveau atteint :
`verificationLevel`, de `0` à `3`.

| Niveau | Ce qui est vérifié | Déclaration                            | Pièces (`kind`)                                            |
| ------ | ------------------ | -------------------------------------- | ---------------------------------------------------------- |
| 1      | identité           | `PUT /me/verification/identity`        | `IDENTITY_FRONT`, `IDENTITY_BACK` selon la pièce, `SELFIE` |
| 2      | adresse            | `PUT /me/verification/address`         | 1 à 3 `PROOF_OF_ADDRESS`                                   |
| 3      | origine des fonds  | `PUT /me/verification/source-of-funds` | 1 à 5 `SOURCE_OF_FUNDS`                                    |

Les niveaux s'obtiennent **dans l'ordre**. Pour chacun, le titulaire prépare un dossier,
y joint ses pièces, puis le dépose ; la conformité l'accepte ou le refuse.

| Route                                                          | Corps          | Réponse       |
| -------------------------------------------------------------- | -------------- | ------------- |
| `GET /api/v1/me/verification`                                  | —              | situation     |
| `PUT /api/v1/me/verification/identity`                         | déclaration    | dossier       |
| `PUT /api/v1/me/verification/address`                          | déclaration    | dossier       |
| `PUT /api/v1/me/verification/source-of-funds`                  | déclaration    | dossier       |
| `GET /api/v1/me/verification/cases/{caseId}`                   | —              | dossier       |
| `DELETE /api/v1/me/verification/cases/{caseId}`                | —              | `204`         |
| `POST /api/v1/me/verification/cases/{caseId}/documents?kind=…` | **le fichier** | `201` dossier |
| `DELETE /api/v1/me/verification/cases/{caseId}/documents/{id}` | —              | dossier       |
| `POST /api/v1/me/verification/cases/{caseId}/submit`           | —              | dossier       |

- **Situation.** `level`, et pour chaque niveau : `verified`, `verifiedAt`, `available` (un
  dossier peut être préparé ou repris maintenant) et `currentCase` (le dernier dossier, avec
  son statut et, s'il a été refusé, les motifs).
- **Statuts d'un dossier.** `DRAFT` (en préparation), `SUBMITTED` (déposé, en attente),
  `APPROVED`, `REJECTED`, `SUPERSEDED` (remplacé par un dossier plus récent), `REVOKED`
  (vérification retirée), `ACCOUNT_CLOSED` (accepté, jusqu'à la clôture du compte — visible du
  seul back-office). Seul un `DRAFT` se modifie ou s'efface.
- **Enregistrer une déclaration** crée le dossier en préparation du niveau, ou remplace sa
  déclaration — les pièces déjà jointes sont conservées. `409 CONFLICT` tant qu'un dossier du
  niveau attend l'examen, ou si le niveau précédent n'est pas vérifié. Au plus 30
  enregistrements par heure.
  - _Identité_ : `givenName`, `familyName`, `additionalName` (postnom), `dateOfBirth`,
    `placeOfBirth`, `nationality`, et `document` : `type` (`NATIONAL_ID_CARD`, `VOTER_CARD`,
    `PASSPORT`, `DRIVING_LICENCE`), `number`, `issuingCountry`, `issuedOn`, `issuedAt`,
    `expiresOn`. Tout doit correspondre à la pièce. Le titulaire a 18 ans révolus ; la pièce
    n'est pas expirée ; un passeport porte une date d'expiration ; la carte d'électeur n'est
    acceptée que délivrée par la RDC. Le numéro est conservé chiffré et **n'est rendu que
    masqué** (`numberMasked`).
  - _Adresse_ : `addressLine1`, `addressLine2`, `city`, `region`, `postalCode`, `country`
    (celui du compte), et `proof` : `type` (`UTILITY_BILL`, `BANK_STATEMENT`,
    `RESIDENCE_CERTIFICATE`, `LEASE_AGREEMENT`, `TAX_DOCUMENT`, `OTHER`) et `issuedOn` — 92
    jours au plus.
  - _Origine des fonds_ : `sources` (une ou plusieurs parmi `EMPLOYMENT`, `BUSINESS`,
    `SAVINGS`, `INVESTMENTS`, `INHERITANCE`, `SALE_OF_PROPERTY`, `FAMILY_SUPPORT`, `PENSION`,
    `OTHER`), `occupation`, `employerName`, `explanation` (20 caractères au moins).
- **Joindre une pièce.** Le corps de la requête est **le fichier lui-même** — pas un
  formulaire —, avec son propre `Content-Type` : `image/jpeg`, `image/png` ou
  `application/pdf` (un autoportrait est une image). De 1 Ko à 5 Mio. Le contenu est confronté
  au type annoncé (`415 UNSUPPORTED_MEDIA_TYPE` s'il ne correspond pas), puis chiffré.
  Renvoyer un recto, un verso ou un autoportrait **remplace** le précédent. Le verso est exigé
  pour une carte d'identité, une carte d'électeur et un permis de conduire. Le dossier indique
  ce qui manque encore (`missingDocuments`). Une pièce envoyée ne se retélécharge pas.

  ```bash
  curl -X POST "$API/me/verification/cases/$CASE/documents?kind=IDENTITY_FRONT" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: image/jpeg" --data-binary @recto.jpg
  ```

  Limites : 40 envois par heure et par compte ; le fichier entier doit arriver en deux minutes
  (`408 REQUEST_TIMEOUT` sinon) — **compresser les photographies avant l'envoi**. Une réponse
  `503` accompagnée de `Retry-After` signifie que trop de pièces sont en cours de réception :
  réessayer après ce délai.

- **Déposer** fige le dossier et le place dans la file d'examen. `422 UNPROCESSABLE_ENTITY`
  s'il manque une pièce, ou si la déclaration n'est plus valable ce jour-là (pièce expirée
  depuis, justificatif devenu trop ancien). Au plus 5 dépôts par jour.
- **La décision** est notifiée par e-mail et figure dans l'historique du compte. Un refus
  donne ses motifs (`rejectionReasons` : `DOCUMENT_UNREADABLE`, `DOCUMENT_EXPIRED`,
  `DOCUMENT_NOT_ACCEPTED`, `DOCUMENT_INCOMPLETE`, `INFORMATION_MISMATCH`, `SELFIE_UNUSABLE`,
  `SELFIE_MISMATCH`, `PROOF_TOO_OLD`, `INSUFFICIENT_EVIDENCE`, `OTHER`) ; le titulaire peut
  alors préparer un nouveau dossier.
- **Renouveler une pièce** : préparer et déposer un nouveau dossier du même niveau. Tant qu'il
  n'est pas accepté, l'ancien reste en vigueur ; accepté, il le remplace.
- Un dossier resté en préparation **30 jours** sans changement est effacé, avec ses pièces.
- Le dossier d'un autre compte « n'existe pas » (`404`). Sans stockage chiffré configuré
  côté serveur, tout sauf la situation répond `503 SERVICE_UNAVAILABLE`.

## Administration

Routes réservées aux comptes détenant la permission indiquée (`403 FORBIDDEN` sinon ; le
refus est inscrit au journal d'audit). Les utilisateurs finaux n'ont aucune permission.

**Le back-office exige la validation en deux étapes** : sans elle, toute route
d'administration répond `403 MFA_ENROLLMENT_REQUIRED`, quelles que soient les permissions.

| Route                                                 | Permission              | Rôle                                                         |
| ----------------------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `GET /api/v1/admin/system-settings`                   | `system_settings.read`  | paramètres et valeurs en vigueur                             |
| `PUT /api/v1/admin/system-settings/{key}`             | `system_settings.write` | mode maintenance, ouverture d'une fonctionnalité             |
| `GET /api/v1/admin/users`                             | `users.read`            | parcourir la liste des comptes                               |
| `POST /api/v1/admin/users/search`                     | `users.read`            | retrouver un compte par un identifiant complet               |
| `GET /api/v1/admin/users/{userId}`                    | `users.read`            | fiche d'un compte                                            |
| `POST /api/v1/admin/users/{userId}/suspend`           | `users.suspend`         | suspendre (`reason`, `notifyUser?`)                          |
| `POST /api/v1/admin/users/{userId}/reactivate`        | `users.suspend`         | lever une suspension (`reason`)                              |
| `POST /api/v1/admin/users/{userId}/sessions/revoke`   | `users.revoke_sessions` | déconnecter le compte partout (`reason`)                     |
| `POST /api/v1/admin/users/{userId}/mfa/reset`         | `users.reset_mfa`       | retirer le second facteur (`reason`)                         |
| `POST /api/v1/admin/users/{userId}/close`             | `users.close`           | clore le compte (`ground`, `reason`, `confirm`)              |
| `GET /api/v1/admin/roles`                             | `roles.read`            | rôles, permissions, nombre de détenteurs                     |
| `GET /api/v1/admin/role-changes`                      | `roles.read`            | demandes de changement de rôle                               |
| `POST /api/v1/admin/role-changes`                     | `roles.manage`          | demander l'attribution ou le retrait d'un rôle               |
| `GET /api/v1/admin/role-changes/{requestId}`          | `roles.read`            | une demande                                                  |
| `POST /api/v1/admin/role-changes/{requestId}/approve` | `roles.manage`          | approuver — **par un second administrateur**                 |
| `POST /api/v1/admin/role-changes/{requestId}/reject`  | `roles.manage`          | refuser (`note`) — par un second administrateur              |
| `POST /api/v1/admin/role-changes/{requestId}/cancel`  | `roles.manage`          | retirer sa propre demande                                    |
| `GET /api/v1/admin/kyc/cases`                         | `kyc.read`              | file des dossiers de vérification                            |
| `GET /api/v1/admin/kyc/cases/{caseId}`                | `kyc.read`              | fiche d'un dossier                                           |
| `GET /api/v1/admin/kyc/cases/{caseId}/documents/{id}` | `kyc.read`              | télécharger une pièce                                        |
| `POST /api/v1/admin/kyc/cases/{caseId}/approve`       | `kyc.review`            | accepter (`note?`)                                           |
| `POST /api/v1/admin/kyc/cases/{caseId}/reject`        | `kyc.review`            | refuser (`reasons`, `note`)                                  |
| `POST /api/v1/admin/kyc/cases/{caseId}/revoke`        | `kyc.revoke`            | retirer une vérification acceptée (`reason`)                 |
| `GET /api/v1/admin/terms/versions`                    | `terms.publish`         | versions des conditions d'utilisation, et leurs acceptations |
| `POST /api/v1/admin/terms/versions`                   | `terms.publish`         | publier une version — **définitif**                          |

Rôles système : **`super_admin`** (toutes les permissions), **`support`** (`users.read`,
`users.suspend`, `users.revoke_sessions`) et **`compliance`** (`users.read`, `users.close`,
`kyc.read`, `kyc.review`, `kyc.revoke`). Le support ne voit aucune pièce d'identité et ne
clôt aucun compte ; la conformité ne suspend ni ne déconnecte un compte : elle le clôt. Seul
`super_admin` publie les conditions d'utilisation (`terms.publish`).

```json
PUT /api/v1/admin/system-settings/features.registration
{ "value": true, "reason": "Autorisation obtenue le 12/03" }
```

La justification (`reason`, 10 caractères au moins) est obligatoire ; la décision, son auteur
et sa justification sont écrits au journal d'audit dans la même transaction.

### Comptes

- **Recherche par identifiant complet** : `POST /admin/users/search` avec, dans le corps,
  `email`, `phone` (format international) ou `id` — exactement un, jamais de fragment. La
  réponse est `{ "users": [...] }` : le plus souvent un compte ou aucun ; un numéro déclaré
  mais jamais vérifié peut en désigner plusieurs.
- **Aucun identifiant personnel dans une URL** : l'adresse ou le numéro recherché voyage dans
  le corps de la requête, parce qu'une URL est conservée bien au-delà de l'API (équipements
  de l'hébergeur, proxys, historique du navigateur). `GET /admin/users` refuse tout autre
  paramètre que `status`, `limit` (≤ 100) et `before` (`400 VALIDATION_FAILED`) ; il parcourt
  la liste du compte le plus récent au plus ancien.
- **Tout accès est journalisé** : chaque recherche (critère et nombre de résultats — de
  l'identifiant saisi, seulement une empreinte), chaque page de la liste et chaque
  consultation de fiche.
- La fiche montre le compte, son profil — vérifié ou seulement **déclaré**, ce que précise
  `verification` (`level`, `identityVerified`, `addressVerified`) —, l'état du second facteur,
  le nombre de sessions ouvertes et où il en est des conditions d'utilisation (`terms` :
  `accepted` — dernière version acceptée et sa date — et `acceptanceRequired`). Aucun secret
  d'authentification n'est jamais renvoyé.
- **Toute action est justifiée** (`reason`, 10 à 500 caractères), et la justification est
  écrite au journal d'audit dans la transaction qui applique l'action.
- **Suspendre** n'est possible que pour un compte actif : ses sessions sont fermées, il ne peut
  plus se connecter (`403 ACCOUNT_DISABLED`). Le titulaire est prévenu par e-mail — jamais de
  la raison — sauf `notifyUser: false`. **Réactiver** ne ranime aucune session.
- **Retirer le second facteur** ramène le compte à la seule protection de son mot de passe :
  toutes ses sessions sont fermées et le titulaire est **toujours** prévenu. La procédure du
  support doit avoir établi l'identité du demandeur auparavant (voir `SECURITY.md`).
- **Clore** (`users.close`) est **définitif** et vaut exactement la clôture par le titulaire
  (voir « Copie des données et clôture du compte ») : `ground` dit pourquoi — `HOLDER_REQUEST`
  (le titulaire l'a demandé par un autre canal, par exemple parce qu'il n'a plus accès à son
  compte) ou `PLATFORM_DECISION` —, `confirm` vaut `true`, et le titulaire est **toujours**
  prévenu, jamais de la raison. Compte actif ou suspendu seulement. `409 CONFLICT` tant que
  le compte détient un rôle, ou qu'un de ses dossiers de vérification attend l'examen : le
  dossier est d'abord décidé, pour que la décision soit conservée. `409 CONFLICT` aussi si
  une autre requête modifie le compte au même instant et tarde à s'achever : à refaire.
- **Compte clôturé.** Sa fiche porte `closure` : `closedAt`, `origin` (`HOLDER` \| `STAFF`),
  `closedBy`, `legalRetentionUntil`, `erasureDueAt`, `formerEmail`, `formerPhone` et
  `erasedAt` — l'ancienne adresse et l'ancien numéro valent `null` une fois effacés. Son
  adresse affichée est factice (`closed-<id>@closed.invalid`). Une recherche par adresse ou
  par numéro rend d'abord le compte qui les porte aujourd'hui, puis les comptes clôturés qui
  les portaient — jusqu'à leur effacement. Plus aucune action ne s'y applique
  (`409 CONFLICT`).
- **Nul n'agit sur son propre compte** par le back-office (`403`), et agir sur le compte d'un
  membre du personnel exige en plus `roles.manage` : le support ne peut ni suspendre ni
  déconnecter un administrateur.

### Conditions d'utilisation : publication

```json
POST /api/v1/admin/terms/versions
{
  "number": 2,
  "requiresAcceptance": true,
  "reason": "Texte validé par le conseil le 12/03",
  "fr": { "summary": "Ce qui change : …", "body": "# Conditions d'utilisation\n\n…" },
  "en": { "summary": "What changes: …", "body": "# Terms of use\n\n…" }
}
```

- **Publier est définitif** : la version est en vigueur aussitôt, ne se modifie pas et ne se
  retire pas. Corriger un texte, c'est publier la version suivante.
- **`number`** doit être le numéro de la version en vigueur plus un (`1` pour la première).
  Une requête envoyée deux fois, ou préparée sur la foi d'un état dépassé, est refusée
  (`409 CONFLICT`, le numéro attendu figure dans `detail`) au lieu de créer une version de trop.
- **`requiresAcceptance`** est la règle de la version (voir « Conditions d'utilisation »). La
  version 1 l'exige toujours (`400 VALIDATION_FAILED` sinon).
- **Textes.** `fr` est obligatoire et fait foi ; `en` est une traduction facultative, entière
  ou absente. `body` : 200 000 caractères au plus ; `summary` : 1 000 au plus. Texte brut ou
  Markdown, **conservé tel quel, à l'octet près** : ni espaces retirés, ni fins de ligne
  converties. Sont refusés un texte blanc, un caractère de contrôle autre que le saut de
  ligne, le retour chariot et la tabulation, et une marque d'ordre des octets en tête.
- **Corps de la requête** : JSON en UTF-8 **valide**, d'un mébioctet au plus (`413` au-delà ;
  `415` si ce n'est pas du JSON ; `400 MALFORMED_REQUEST` si le JSON ou son encodage est
  invalide — un fichier enregistré dans un autre encodage est refusé, non « réparé »). C'est
  la seule route JSON qui dépasse la limite commune ; son corps n'est lu qu'**après**
  l'authentification et le contrôle des droits. Les deux limites s'appliquent, en
  caractères et en octets : deux textes de la longueur maximale tiennent dans un mébioctet
  en français ou en anglais (un à deux octets par caractère).
- **Réponse** `201` : la version sans ses textes — `number`, `publishedAt`, `publishedBy`,
  `requiresAcceptance`, `current`, `acceptances`, et pour chaque langue `summary`, `length`
  (caractères) et `sha256`. **Comparer `sha256` à l'empreinte du fichier qu'on voulait
  publier** (`sha256sum`) : c'est la preuve que le texte conservé est le bon.
- `reason` (10 à 500 caractères) est écrite au journal d'audit avec les empreintes. Au plus 20
  publications par heure et par client. **Aucun e-mail n'est envoyé aux titulaires** : ils
  apprennent qu'ils doivent accepter en se connectant ou sur `GET /me`.
- **Suivi.** `GET /admin/terms/versions` rend les 100 versions les plus récentes : pour
  chacune, son auteur (`publishedBy` ; `null` si elle a été publiée depuis la ligne de commande
  du serveur), sa règle, la longueur et l'empreinte de chaque texte, et `acceptances` — le
  nombre de comptes qui l'ont acceptée (un compte clôturé n'est plus compté ; une inscription
  dont l'adresse n'est pas encore vérifiée l'est).
- Ces deux routes restent ouvertes pendant la maintenance : on doit pouvoir publier un texte
  avant de rouvrir la plateforme. Le personnel n'a pas à avoir accepté lui-même la version en
  vigueur pour utiliser le back-office.
- **Sans back-office** — première version avant l'ouverture, par exemple —, l'opérateur du
  serveur publie avec `pnpm terms:publish` (voir `DEPLOYMENT.md`) : mêmes règles, mêmes bornes.

### Rôles : double validation

Aucune route n'attribue ni ne retire un rôle directement.

1. Un administrateur **demande** le changement (`userId`, `roleKey`, `action` : `GRANT` ou
   `REVOKE`, `reason`). Rien ne change. La demande échoit après **72 heures**.
2. Un **second** administrateur l'**approuve** : le changement est appliqué dans la même
   transaction, et prend effet à la requête suivante du compte concerné. Il peut aussi la
   **refuser** (`note` obligatoire) ; l'auteur peut la **retirer**.

Nul ne prend part à un changement de ses propres rôles, ni pour le demander, ni pour le
décider. Ces règles sont imposées par la base de données elle-même, qui vérifie en outre, au
moment de l'approbation, que l'auteur de la demande et l'approbateur sont toujours actifs et
détiennent toujours `roles.manage` (`409 CONFLICT` sinon) : l'API n'a aucun droit d'écriture
sur les attributions de rôles. Statuts : `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`, `EXPIRED`.

De deux décisions simultanées sur une même demande, une seule s'applique ; l'autre reçoit
`409 CONFLICT`. Une demande déjà décidée répond de même.

### Vérification d'identité : examen des dossiers

- **La file** (`GET /admin/kyc/cases`) présente les dossiers déposés, **du dépôt le plus
  ancien au plus récent** — par défaut ceux qui attendent (`status=SUBMITTED`). Filtres :
  `status`, `level`, `userId` ; pagination : `after` = `nextCursor` de la page précédente,
  `limit` ≤ 100. Un dossier en préparation n'est jamais visible du personnel.
- **La fiche** donne la déclaration complète — y compris le **numéro entier** de la pièce —,
  les pièces, et ce qui aide à juger : `seenOnOtherAccounts` (le même fichier déposé par
  d'autres comptes), `sameIdentityDocument` (la même pièce d'identité présentée par d'autres
  comptes), `replacesCaseId` (le dossier accepté que celui-ci remplacerait), `history` (les
  autres dossiers du compte), ainsi que la décision et sa note une fois prise.
- **Une pièce** est rendue déchiffrée, **en pièce jointe**, après vérification de son
  intégrité. Une pièce altérée ou disparue n'est jamais rendue (`500`) et l'incident est tracé.
- **Tout accès est journalisé** : chaque page de la file, chaque fiche, chaque téléchargement.
- **Accepter** vérifie le niveau ; le profil du compte reprend ce que le dossier établit.
  `409 CONFLICT` si le dossier a déjà été décidé, si le niveau précédent n'est plus vérifié,
  ou si **un autre compte est déjà vérifié avec la même pièce d'identité**.
- **Refuser** demande un à cinq motifs (`reasons`), communiqués au titulaire, et une note
  interne (`note`, 10 à 500 caractères) qui ne l'est jamais.
- **Retirer** une vérification acceptée (`reason`, interne) fait retomber le niveau du compte
  sous ce niveau : les niveaux supérieurs, bien que toujours acceptés, ne comptent plus. Le
  titulaire apprend seulement que la vérification a été retirée.
- **Nul n'examine son propre dossier** (`403`), et la tentative est tracée. De deux décisions
  simultanées, une seule s'applique ; l'autre reçoit `409 CONFLICT`.
- Ces routes restent accessibles pendant la maintenance et lorsque la fonctionnalité `kyc`
  est fermée aux titulaires.

**Premier administrateur.** Aucune route ne permet d'obtenir un rôle sans l'accord de deux
administrateurs : les premiers comptes d'administration se créent en ligne de commande, avec
le rôle propriétaire de la base (voir `DEPLOYMENT.md`). Il en faut **au moins deux** pour que
les rôles puissent évoluer par l'API.

## Boîte de réception de développement

Lorsqu'aucun serveur d'envoi n'est configuré, les messages — e-mails et SMS, dont les codes —
restent en mémoire en local, en développement et en test :

```
GET /api/v1/dev/mailbox?recipient=<adresse e-mail ou numéro de téléphone>
```

Cette route n'existe pas en pré-production ni en production, ni dès que les e-mails partent
réellement (`404`).

**Disponibilité des envois.** Une route qui dépend d'un message répond
`503 SERVICE_UNAVAILABLE` lorsque le canal correspondant n'est pas configuré : inscription,
renvoi du code et mot de passe oublié sans serveur d'e-mail ; vérification du numéro de
téléphone sans prestataire SMS — ce qui est le cas partout hors développement à ce jour.

## À venir

Vérification des entreprises (KYB) et plafonds par niveau de vérification (fin de la phase 2
et phase 3) ;
en-tête `Idempotency-Key` obligatoire sur toute opération financière (phase 3) ; webhooks
entrants signés et protégés contre le rejeu (phase 4).

## Règles d'exposition de la documentation

| Environnement                  | `/api/docs`                                                  |
| ------------------------------ | ------------------------------------------------------------ |
| `local`, `development`, `test` | servie                                                       |
| `staging`                      | désactivée par défaut ; activable derrière authentification  |
| `production`                   | jamais servie (le démarrage échoue si on tente de l'activer) |

## Mettre à jour le document OpenAPI

```bash
pnpm --filter @mgx/api openapi:export
```

Un test échoue tant que `docs/api/openapi.json` ne correspond pas au code.
