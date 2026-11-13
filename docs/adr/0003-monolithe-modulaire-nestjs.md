# 0003 — Monolithe modulaire NestJS 12, couches vérifiées

**Statut :** acceptée (2026-11-11)

## Contexte

Le produit couvre de nombreux domaines mais démarre avec une petite équipe et des volumes
modestes. Des microservices dès le départ ajouteraient transactions distribuées et charge
d'exploitation sans bénéfice immédiat — au détriment de la cohérence financière.

## Décision

- Une application **NestJS 12** unique, découpée en modules par domaine.
- Chaque module métier suit quatre couches : `domain`, `application`, `infrastructure`,
  `presentation`. Les dépendances interdites sont **refusées par ESLint**.
- La persistance est abstraite par des ports (classes abstraites servant de jetons d'injection).
- Adaptateur HTTP **Express 5** (valeur par défaut de NestJS, écosystème le plus large) ;
  le débit sera limité par la base de données bien avant de l'être par l'adaptateur.
- Les modules communiquent par appel de service ou par événement de domaine (ADR 0009),
  jamais en lisant les tables d'un autre module.

## Conséquences

- Une seule transaction ACID peut couvrir une opération financière complète.
- Un domaine pourra être extrait plus tard : ses frontières et ses événements existent déjà.
- La discipline repose sur l'outillage (lint) et la revue, pas sur une barrière réseau.
