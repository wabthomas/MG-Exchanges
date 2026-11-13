# 0015 — Autorisations : refus par défaut, RBAC, amorçage hors de l'API

**Statut :** acceptée (2026-11-11)

## Décision

- **Refus par défaut.** Une garde globale exige une authentification sur toute route ; une
  route n'est publique que si elle porte `@Public()`. Un test compare l'ensemble des routes
  publiques (tirées du document OpenAPI) à une liste fermée et vérifie que toutes les autres
  répondent `401` sans jeton.
- **RBAC.** Les permissions (`ressource.action`) forment un catalogue dans le code
  (`@mgx/contracts`), recopié en base par migration ; un test garantit que les deux sont
  identiques. Un rôle est un ensemble de permissions ; `@RequirePermissions(...)` protège une
  route. Les utilisateurs finaux n'ont aucun rôle : ils n'accèdent qu'à leurs propres données.
- **Droits relus à chaque requête** d'administration : le retrait d'un rôle est immédiat.
- **Aucune élévation de privilège par l'API.** Le rôle PostgreSQL de l'API n'a qu'un droit de
  lecture sur `permissions`, `roles`, `role_permissions` et `user_roles`. Le premier
  administrateur est créé par un outil en ligne de commande, avec le rôle propriétaire de la base.

## Conséquences

- Oublier de protéger une route est impossible ; en ouvrir une demande un geste visible en revue.
- Tant que l'attribution des rôles depuis le back-office n'est pas livrée, tout nouvel
  administrateur passe par la ligne de commande. Cette fonctionnalité exigera d'accorder à
  l'API un droit d'écriture ciblé sur `user_roles`, assorti d'une double validation.
- Seul le rôle `super_admin` existe pour l'instant : les rôles de support, de conformité et de
  finance seront définis avec les fonctionnalités qui leur donnent un contenu.
