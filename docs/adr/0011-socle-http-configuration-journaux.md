# 0011 — En-têtes natifs, configuration typée, Pino

**Statut :** acceptée (2026-11-11)

## Décisions

- **En-têtes de sécurité** : `app.useSecurityHeaders()` de NestJS 12 (mêmes valeurs par
  défaut que Helmet 8) plutôt que le paquet `helmet` — une dépendance en moins. Durcissement :
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS de 2 ans.
- **Configuration** : schéma Zod des variables d'environnement et classe `AppConfig` injectée,
  plutôt que `@nestjs/config`. Accès entièrement typé, aucune clé sous forme de chaîne,
  validation croisée par environnement, échec immédiat et lisible au démarrage.
- **Journalisation** : `nestjs-pino` — JSON structuré, identifiant de requête sur chaque
  ligne. L'expurgation des secrets s'applique à tout objet journalisé, par nom de clé et
  par forme de valeur, à toute profondeur. Le contexte du journal est fixé par
  `logger.setContext()` (le décorateur `@InjectPinoLogger` dépend de l'ordre de chargement
  des modules ES et n'est pas utilisé).
- **Versionnage** : dans le chemin (`/api/v1`) ; chaque contrôleur déclare sa version.
- **Corps des requêtes** : JSON uniquement, taille bornée.

## Conséquences

- Moins de dépendances à suivre ; comportements couverts par les tests de bout en bout.
- OpenTelemetry n'est pas encore intégré : l'identifiant de requête assure la corrélation
  en attendant le traçage distribué (phase 9).
