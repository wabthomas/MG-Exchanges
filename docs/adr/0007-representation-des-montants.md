# 0007 — Représentation des montants

**Statut :** acceptée (2026-11-11)

## Contexte

Un nombre flottant ne représente pas exactement `0.1`. Les actifs gérés vont de 2 décimales
(USD, CDF) à 18 (ETH), et les quantités en wei dépassent largement 2⁵³ comme 2⁶³.

## Décision

| Niveau          | Représentation                                                                |
| --------------- | ----------------------------------------------------------------------------- |
| Code            | `bigint` d'unités minimales, encapsulé dans `Money` (immuable) avec son actif |
| Fil (JSON)      | chaîne décimale canonique (`"12.34"`) — jamais un nombre JSON                 |
| Base de données | `NUMERIC(38,0)` en unités minimales (à partir de la phase 3)                  |

- Aucun arrondi implicite : toute opération qui arrondit exige un mode explicite, car le
  sens de l'arrondi d'un frais est une décision métier.
- Mélanger deux actifs lève une erreur : une conversion est toujours explicite.
- `Money.allocate` répartit sans créer ni perdre d'unité.
- ESLint interdit `parseFloat` et `toFixed` dans tout le dépôt.

## Conséquences

- Précision exacte, démontrée par des tests de propriétés sur des valeurs jusqu'à 10⁴⁰.
- Les clients doivent traiter les montants comme des chaînes et utiliser `@mgx/shared`.
- La conversion entre actifs (taux de change) sera ajoutée avec le moteur d'échange (phase 4).
