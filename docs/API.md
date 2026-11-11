# API

Le contrat exact est le document OpenAPI [`docs/api/openapi.json`](api/openapi.json),
généré à partir du code et vérifié par les tests (importable dans Postman, Insomnia, Bruno).
En développement, il est consultable de façon interactive sur `/api/docs`.

## Conventions

| Sujet           | Règle                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------- |
| Base            | `/api/v{n}/…` — la version figure dans le chemin ; chaque contrôleur déclare la sienne       |
| Format          | JSON uniquement (`Content-Type: application/json`) ; les formulaires ne sont pas interprétés |
| Montants        | chaînes décimales canoniques (`"12.34"`), **jamais** des nombres JSON                        |
| Horodatages     | ISO 8601 en UTC (`2026-01-31T12:00:00.000Z`)                                                 |
| Identifiants    | UUID                                                                                         |
| Entrées         | validées par schéma ; les propriétés inconnues sont refusées                                 |
| Cache           | `Cache-Control: no-store` sur toutes les réponses                                            |
| Taille du corps | 100 Ko par défaut (`HTTP_BODY_LIMIT_BYTES`)                                                  |

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

| Code                     | Statut | Signification                                      |
| ------------------------ | ------ | -------------------------------------------------- |
| `VALIDATION_FAILED`      | 400    | entrée invalide (détail dans `errors`)             |
| `MALFORMED_REQUEST`      | 400    | requête illisible (JSON mal formé…)                |
| `UNAUTHENTICATED`        | 401    | authentification requise ou invalide               |
| `FORBIDDEN`              | 403    | action non autorisée                               |
| `FEATURE_DISABLED`       | 403    | fonctionnalité non ouverte                         |
| `NOT_FOUND`              | 404    | ressource ou route inexistante                     |
| `METHOD_NOT_ALLOWED`     | 405    |                                                    |
| `NOT_ACCEPTABLE`         | 406    |                                                    |
| `REQUEST_TIMEOUT`        | 408    |                                                    |
| `CONFLICT`               | 409    | conflit avec l'état actuel                         |
| `PAYLOAD_TOO_LARGE`      | 413    | corps trop volumineux                              |
| `UNSUPPORTED_MEDIA_TYPE` | 415    |                                                    |
| `UNPROCESSABLE_ENTITY`   | 422    | requête comprise mais refusée par une règle métier |
| `RATE_LIMITED`           | 429    | trop de requêtes (voir `Retry-After`)              |
| `INTERNAL_ERROR`         | 500    | erreur inattendue                                  |
| `MAINTENANCE`            | 503    | plateforme en maintenance                          |
| `SERVICE_UNAVAILABLE`    | 503    | service momentanément indisponible                 |

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
l'administration figure dans `detail`), sauf l'état de la plateforme et les sondes.
Une route rattachée à une fonctionnalité fermée répond `403 FEATURE_DISABLED`.

## Authentification, permissions, événements, webhooks

Non disponibles en phase 1. Conventions déjà arrêtées pour la suite : jeton d'accès dans
`Authorization: Bearer …` ; en-tête `Idempotency-Key` obligatoire sur toute opération
financière (phase 3) ; webhooks entrants signés et protégés contre le rejeu (phase 4).

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
