# API

Le contrat exact est le document OpenAPI [`docs/api/openapi.json`](api/openapi.json),
généré à partir du code et vérifié par les tests (importable dans Postman, Insomnia, Bruno).
En développement, il est consultable de façon interactive sur `/api/docs`.

## Conventions

| Sujet            | Règle                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Base             | `/api/v{n}/…` — la version figure dans le chemin ; chaque contrôleur déclare la sienne       |
| Format           | JSON uniquement (`Content-Type: application/json`) ; les formulaires ne sont pas interprétés |
| Montants         | chaînes décimales canoniques (`"12.34"`), **jamais** des nombres JSON                        |
| Horodatages      | ISO 8601 en UTC (`2026-01-31T12:00:00.000Z`)                                                 |
| Identifiants     | UUID                                                                                         |
| Authentification | `Authorization: Bearer <jeton d'accès>` sur **toute** route, sauf celles dites publiques     |
| Entrées          | validées par schéma ; les propriétés inconnues sont refusées                                 |
| Cache            | `Cache-Control: no-store` sur toutes les réponses                                            |
| Taille du corps  | 100 Ko par défaut (`HTTP_BODY_LIMIT_BYTES`)                                                  |

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

| Code                      | Statut | Signification                                             |
| ------------------------- | ------ | --------------------------------------------------------- |
| `VALIDATION_FAILED`       | 400    | entrée invalide (détail dans `errors`)                    |
| `MALFORMED_REQUEST`       | 400    | requête illisible (JSON mal formé…)                       |
| `INVALID_OR_EXPIRED_CODE` | 400    | code à usage unique refusé, quelle qu'en soit la cause    |
| `UNAUTHENTICATED`         | 401    | jeton d'accès absent, invalide ou expiré                  |
| `INVALID_CREDENTIALS`     | 401    | identifiant ou mot de passe erroné (sans préciser lequel) |
| `FORBIDDEN`               | 403    | action non autorisée                                      |
| `FEATURE_DISABLED`        | 403    | fonctionnalité non ouverte                                |
| `EMAIL_NOT_VERIFIED`      | 403    | mot de passe correct, adresse e-mail non vérifiée         |
| `ACCOUNT_DISABLED`        | 403    | mot de passe correct, compte suspendu ou clôturé          |
| `NOT_FOUND`               | 404    | ressource ou route inexistante                            |
| `METHOD_NOT_ALLOWED`      | 405    |                                                           |
| `NOT_ACCEPTABLE`          | 406    |                                                           |
| `REQUEST_TIMEOUT`         | 408    |                                                           |
| `CONFLICT`                | 409    | conflit avec l'état actuel                                |
| `PAYLOAD_TOO_LARGE`       | 413    | corps trop volumineux                                     |
| `UNSUPPORTED_MEDIA_TYPE`  | 415    |                                                           |
| `UNPROCESSABLE_ENTITY`    | 422    | requête comprise mais refusée par une règle métier        |
| `COUNTRY_NOT_SUPPORTED`   | 422    | pays de résidence non desservi                            |
| `RATE_LIMITED`            | 429    | trop de requêtes (voir `Retry-After`)                     |
| `INTERNAL_ERROR`          | 500    | erreur inattendue                                         |
| `MAINTENANCE`             | 503    | plateforme en maintenance                                 |
| `SERVICE_UNAVAILABLE`     | 503    | service momentanément indisponible                        |

Le catalogue fait foi dans `packages/contracts/src/errors/error-codes.ts`.

### Erreurs produites par le reverse proxy

Nginx répond lui-même dans quatre cas, **au même format** que l'API :

| Cas                                    | Réponse                                     |
| -------------------------------------- | ------------------------------------------- |
| route non relayée vers l'API           | `404 NOT_FOUND`                             |
| corps de plus de 128 Ko                | `413 PAYLOAD_TOO_LARGE`                     |
| limitation de débit amont dépassée     | `429 RATE_LIMITED`, `Retry-After: 1`        |
| API injoignable, arrêtée ou trop lente | `503 SERVICE_UNAVAILABLE`, `Retry-After: 5` |

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
connexion, le renouvellement et la fermeture de session, `GET /api/v1/me`, et
l'administration des paramètres — c'est par elle qu'on sort de la maintenance.
Une route rattachée à une fonctionnalité fermée répond `403 FEATURE_DISABLED`.

## Authentification et sessions

**Refus par défaut.** Toute route exige un jeton d'accès, sauf celles explicitement
publiques : état de la plateforme, sondes, inscription, vérification de l'adresse,
connexion, renouvellement, mot de passe oublié. Sans jeton valide : `401 UNAUTHENTICATED`.

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

Fermée tant que la fonctionnalité `registration` n'est pas ouverte (`403 FEATURE_DISABLED`).

| Route                            | Corps                                                                        | Réponse                                              |
| -------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| `POST /api/v1/auth/register`     | `email`, `password`, `countryCode`, `acceptTerms: true`, `phone?`, `locale?` | `202` `{ nextStep: "VERIFY_EMAIL", codeTtlSeconds }` |
| `POST /api/v1/auth/email/verify` | `email`, `code` (6 chiffres)                                                 | `204`                                                |
| `POST /api/v1/auth/email/resend` | `email`                                                                      | `202`, même corps que l'inscription                  |

- Le compte ne peut pas se connecter avant la vérification de l'adresse.
- Mot de passe : 10 à 128 caractères, aucune règle de composition ; sont refusés les mots de
  passe trop courants, trop répétitifs ou dérivés de l'adresse ou du téléphone.
- Pays desservi au lancement : `CD`. Tout autre pays : `422 COUNTRY_NOT_SUPPORTED`.
- Un code est valable 15 minutes et peut être essayé 5 fois ; au plus 3 codes par quart
  d'heure et par compte. Tout refus répond `400 INVALID_OR_EXPIRED_CODE`, sans en préciser la cause.

**Aucune réponse ne révèle l'existence d'un compte.** S'inscrire avec une adresse déjà prise,
demander un renvoi de code ou une réinitialisation pour une adresse inconnue : la réponse est
identique dans tous les cas. Le titulaire d'un compte existant est, lui, prévenu par e-mail.

### Connexion et session

| Route                                    | Auth. | Corps                              | Réponse                                     |
| ---------------------------------------- | ----- | ---------------------------------- | ------------------------------------------- |
| `POST /api/v1/auth/login`                | non   | `email`, `password`, `deviceName?` | `200` `{ status, tokens, sessionId, user }` |
| `POST /api/v1/auth/refresh`              | non   | `refreshToken`                     | `200` `{ tokens }`                          |
| `POST /api/v1/auth/logout`               | oui   | —                                  | `204`                                       |
| `GET /api/v1/me`                         | oui   | —                                  | compte, rôles et permissions                |
| `GET /api/v1/me/sessions`                | oui   | —                                  | sessions ouvertes (« mes appareils »)       |
| `DELETE /api/v1/me/sessions/{sessionId}` | oui   | —                                  | `204`                                       |
| `POST /api/v1/me/sessions/revoke-others` | oui   | —                                  | `200` `{ revoked }`                         |

- `status` vaut `AUTHENTICATED`. Les clients doivent se fonder sur ce champ : d'autres valeurs
  (second facteur requis…) s'ajouteront sans changement de version.
- Adresse inconnue et mot de passe erroné reçoivent la même réponse : `401 INVALID_CREDENTIALS`.
- **Blocage temporaire** : 5 échecs en 15 minutes bloquent ce client (compte + adresse IP)
  15 minutes ; 20 échecs en une heure bloquent le compte une heure pour tous. Réponse :
  `429 RATE_LIMITED` avec `Retry-After`. Pendant le blocage, même le bon mot de passe est refusé.
- `EMAIL_NOT_VERIFIED` et `ACCOUNT_DISABLED` ne sont renvoyés qu'à qui présente le bon mot de passe.

### Mot de passe

| Route                               | Auth. | Corps                            | Réponse                                                |
| ----------------------------------- | ----- | -------------------------------- | ------------------------------------------------------ |
| `POST /api/v1/auth/password/forgot` | non   | `email`                          | `202` `{ nextStep: "RESET_PASSWORD", codeTtlSeconds }` |
| `POST /api/v1/auth/password/reset`  | non   | `email`, `code`, `newPassword`   | `204` — **toutes** les sessions sont fermées           |
| `POST /api/v1/auth/password/change` | oui   | `currentPassword`, `newPassword` | `204` — les **autres** sessions sont fermées           |

Le titulaire est prévenu par e-mail de tout changement de mot de passe.

## Administration

Routes réservées aux comptes détenant la permission indiquée (`403 FORBIDDEN` sinon ; le
refus est inscrit au journal d'audit). Les utilisateurs finaux n'ont aucune permission.

| Route                                     | Permission              | Rôle                                             |
| ----------------------------------------- | ----------------------- | ------------------------------------------------ |
| `GET /api/v1/admin/system-settings`       | `system_settings.read`  | paramètres et valeurs en vigueur                 |
| `PUT /api/v1/admin/system-settings/{key}` | `system_settings.write` | mode maintenance, ouverture d'une fonctionnalité |

```json
PUT /api/v1/admin/system-settings/features.registration
{ "value": true, "reason": "Autorisation obtenue le 12/03" }
```

La justification (`reason`, 10 caractères au moins) est obligatoire ; la décision, son auteur
et sa justification sont écrits au journal d'audit dans la même transaction.

**Premier administrateur.** Aucune route ne permet d'obtenir un rôle : le premier compte
d'administration se crée en ligne de commande, avec le rôle propriétaire de la base
(voir `DEPLOYMENT.md`).

## Boîte de réception de développement

Tant qu'aucun prestataire d'envoi n'est branché, les messages (dont les codes) restent en
mémoire en local, en développement et en test :

```
GET /api/v1/dev/mailbox?recipient=<adresse>
```

Cette route n'existe pas en pré-production ni en production (`404`), où l'inscription et la
réinitialisation répondent `503 SERVICE_UNAVAILABLE` tant qu'aucun moyen d'envoi n'est configuré.

## À venir

Second facteur (TOTP), vérification du téléphone, profil et préférences, KYC/KYB ; en-tête
`Idempotency-Key` obligatoire sur toute opération financière (phase 3) ; webhooks entrants
signés et protégés contre le rejeu (phase 4).

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
