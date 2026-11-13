# 0010 — Limitation de débit maison sur Redis

**Statut :** acceptée (2026-11-11)

## Contexte

`@nestjs/throttler` est le module usuel. Publié en CommonJS, il ne se charge pas sous Jest
avec NestJS 12 en modules ES (ADR 0004). Son stockage par défaut est en mémoire, donc
contournable dès qu'il y a plusieurs instances.

## Décision

- Garde globale `RateLimitGuard` et limiteur `RedisRateLimiter` (une centaine de lignes).
- Compteur à fenêtre fixe, **atomique** (script Lua), partagé par toutes les instances.
- Par adresse IP cliente, résolue selon `TRUST_PROXY_HOPS`.
- `@RateLimit({ name, limit, windowMs })` pour une limite dédiée ; `@SkipRateLimit()` pour les sondes.
- **Fermé en cas de panne** : Redis indisponible = requête refusée.

## Conséquences

- Une dépendance en moins ; comportement entièrement testé sur Redis réel, concurrence comprise.
- Une fenêtre fixe tolère une rafale à cheval sur deux fenêtres : acceptable en première
  ligne, Nginx limitant aussi en amont. Fenêtre glissante et limites par compte : phase 2.
