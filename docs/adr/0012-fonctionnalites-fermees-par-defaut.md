# 0012 — Fonctionnalités réglementées fermées par défaut

**Statut :** acceptée (2026-11-11)

## Contexte

La disponibilité technique d'une fonctionnalité ne vaut pas autorisation légale. Les
activités de la plateforme (monnaie électronique, change, actifs numériques) sont
réglementées et les autorisations s'obtiendront progressivement, pays par pays.

## Décision

- Chaque fonctionnalité est un paramètre système (`features.*`), **désactivé par défaut**.
- `@RequiresFeature('<fonctionnalité>')` soumet une route à ce paramètre ; fermée, elle
  répond `403 FEATURE_DISABLED`.
- Ouvrir une fonctionnalité est une modification tracée : valeur, entrée d'audit (auteur,
  justification) et événement sont écrits dans une même transaction.
- Une valeur invalide en base est ignorée au profit de l'état fermé.
- Un mode maintenance global ferme l'API, hors sondes et état de la plateforme.
- `GET /api/v1/system/status` publie l'état des fonctionnalités aux clients.

## Conséquences

- Du code peut être livré et testé sans être exposé au public.
- Le point d'accès d'administration (avec permissions et double validation) arrive en
  phase 2 ; d'ici là, aucune interface ne permet d'ouvrir une fonctionnalité.
- Les règles par pays viendront enrichir ce mécanisme en phase 8.
