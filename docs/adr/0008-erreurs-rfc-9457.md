# 0008 — Erreurs normalisées RFC 9457 et codes stables

**Statut :** acceptée (2026-11-11)

## Contexte

Trois clients et, à terme, des partenaires consommeront l'API. Ils doivent pouvoir réagir
à une erreur de façon fiable, et le support retrouver la requête concernée.

## Décision

- Toute erreur est renvoyée en `application/problem+json` (RFC 9457) par un filtre global unique.
- Extensions : `code` (identifiant stable du catalogue de `@mgx/contracts`), `requestId`,
  `timestamp`, `errors` (détail par champ).
- Le code applicatif lève `AppError(code, message)` ; son message est destiné au client.
- Toute autre exception est une erreur inattendue : journalisée avec sa pile, renvoyée
  sous la forme d'un message générique `INTERNAL_ERROR`.
- Les messages sont en anglais ; les clients traduisent à partir de `code`.
- Les erreurs produites par le reverse proxy (route inconnue, corps trop volumineux,
  limitation de débit, API injoignable) suivent le même contrat ; un test compare la
  configuration de Nginx au schéma.

## Conséquences

- Un code publié n'est jamais renommé ni réaffecté.
- Aucun détail interne (SQL, pile, hôte) ne peut atteindre le client par inadvertance.
