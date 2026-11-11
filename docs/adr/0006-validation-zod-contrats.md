# 0006 — Validation par schémas Zod partagés

**Statut :** acceptée (2026-11-11)

## Contexte

L'API, le web et le mobile doivent partager exactement les mêmes règles de validation et
les mêmes formes de données. NestJS 12 prend en charge nativement les schémas « Standard
Schema » (`@Body({ schema })`), et `@nestjs/swagger` sait les convertir en OpenAPI.

## Décision

- **Zod 4** comme unique langage de schéma : le schéma valide à l'exécution et fournit le type TypeScript.
- `@mgx/validation` porte les primitives ; `@mgx/contracts` les formes de l'API et le
  catalogue d'erreurs. Ces paquets n'ont aucune dépendance serveur.
- Les schémas d'entrée utilisent `z.strictObject` : toute propriété inconnue est refusée.
- `class-validator` et `class-transformer` ne sont pas utilisés.
- Le document OpenAPI est produit à partir du code et versionné (`docs/api/openapi.json`) ;
  un test échoue s'il diverge.

## Conséquences

- Une règle de validation n'est écrite qu'une fois et sert aux trois clients.
- Les réponses de l'API sont vérifiées contre leur contrat dans les tests de bout en bout.
