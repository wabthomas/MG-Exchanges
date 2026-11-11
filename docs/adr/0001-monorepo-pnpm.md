# 0001 — Monorepo pnpm, versions épinglées, chaîne d'approvisionnement

**Statut :** acceptée (2026-11-11)

## Contexte

La plateforme réunira une API, une application web, des applications mobiles et un
back-office qui partagent contrats, validation et règles de calcul. Une plateforme
financière doit en outre maîtriser précisément ce qu'elle installe.

## Décision

- Un seul dépôt, espaces de travail **pnpm 12** : `apps/*` et `packages/*`.
- Versions **exactes**, centralisées dans le catalogue de `pnpm-workspace.yaml` ; fichier de
  verrouillage figé en CI.
- `minimumReleaseAge: 4320` : une version publiée depuis moins de 3 jours n'est pas installée.
- Scripts d'installation refusés par défaut (`allowBuilds` explicite et commenté).
- Pas d'orchestrateur de tâches (Turborepo, Nx) pour l'instant : `pnpm -r` suffit à cinq paquets.

## Conséquences

- Une montée de version est un changement explicite et relu, jamais un effet de bord.
- Les correctifs de sécurité urgents de moins de 3 jours exigent une exception assumée.
- À réévaluer à l'arrivée du web et du mobile (phase 7) : cache de build et exécution sélective.
