# 0017 — Validation en deux étapes : TOTP, secret chiffré, connexion en deux temps

**Statut :** acceptée (2026-11-12)

## Contexte

Un mot de passe seul ne suffit pas à protéger un compte financier, et encore moins un compte
du back-office. Il faut un second facteur utilisable en RDC, où le SMS est coûteux, peu fiable
et exposé au détournement de carte SIM.

## Décision

**Facteur.** TOTP (RFC 6238) avec les paramètres que toutes les applications d'authentification
acceptent : SHA-1, 6 chiffres, 30 secondes, tolérance d'un pas. Implémentation directe sur
`node:crypto`, vérifiée contre les vecteurs des RFC 4226 et 6238 : une quarantaine de lignes,
sans dépendance supplémentaire dans le chemin d'authentification. Le SMS n'est **pas** un
second facteur : il ne sert qu'à vérifier un numéro.

**Un code ne sert qu'une fois.** Le dernier pas de temps accepté est retenu ; la comparaison
et l'écriture sont une seule instruction SQL — de deux présentations simultanées du même code,
une seule passe.

**Secret chiffré au repos.** Contrairement à un mot de passe, le secret TOTP doit pouvoir être
relu : il est chiffré (AES-256-GCM) avec une clé hors de la base
(`AUTH_SECRETS_ENCRYPTION_KEY`), et lié au compte par les données authentifiées. Format :
version ‖ nonce ‖ chiffré ‖ sceau ; la base refuse toute autre forme. L'octet de version
permettra une rotation de clé sans migration.

**Codes de secours.** Dix codes de dix caractères (base32 de Crockford, 50 bits), à usage
unique, stockés sous forme d'empreinte HMAC ; remis une seule fois.

**Connexion en deux temps.** Après le mot de passe, **aucune session n'est créée** : la
réponse porte `status: MFA_REQUIRED` et un jeton de connexion en attente (Redis, 5 minutes,
5 présentations, usage unique, empreinte seule conservée). Il n'existe donc pas de « session à
moitié authentifiée » dont il faudrait restreindre les droits route par route.

**Essais bornés par compte.** 5 codes erronés en 15 minutes bloquent la seconde étape
15 minutes ; 20 en 24 heures, 24 heures, sans remise à zéro par une connexion réussie. Les
compteurs portent sur le compte, pas sur l'adresse IP : celui qui essaie des codes connaît déjà
le mot de passe.

**Modifier le second facteur** exige de présenter à nouveau le mot de passe, ferme les autres
sessions et prévient le titulaire. **Réinitialiser le mot de passe ne le retire pas.**

**Le back-office l'exige** : la garde des permissions refuse tout compte qui ne l'a pas activé.

## Conséquences

- Perdre `AUTH_SECRETS_ENCRYPTION_KEY` rend tous les seconds facteurs invérifiables : la clé
  doit être sauvegardée, séparément de la base. Sa rotation n'est pas encore outillée.
- Un titulaire qui perd son téléphone **et** ses codes de secours dépend du support, dont la
  procédure de vérification d'identité reste à écrire (voir `SECURITY.md`).
- Un attaquant qui connaît le mot de passe peut bloquer la seconde étape du compte (déni de
  service borné à 24 heures) ; le titulaire en est prévenu et peut changer son mot de passe.
- Le TOTP ne résiste pas à l'hameçonnage en temps réel. Les clés d'accès (WebAuthn) sont la
  suite prévue ; le modèle (`methods` dans la réponse de connexion) laisse la place de les ajouter.
- Un administrateur créé en ligne de commande doit activer son second facteur avant toute
  action — y compris pour sortir du mode maintenance, d'où l'accessibilité de ces routes
  pendant la maintenance.
