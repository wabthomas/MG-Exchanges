# 0016 — Codes à usage unique et non-divulgation des comptes

**Statut :** acceptée (2026-11-11)

## Contexte

L'inscription, la vérification de l'adresse et la réinitialisation du mot de passe reposent
sur un code envoyé à l'utilisateur. Ces parcours sont les cibles habituelles de deux attaques :
deviner un code, et découvrir quelles adresses ont un compte.

## Décision

**Codes.**

- Six chiffres, valables 15 minutes, **5 essais** (comptés avant examen, de façon atomique ; la
  base elle-même refuse tout dépassement), 3 codes par quart d'heure et par compte, un seul
  code valable à la fois.
- Le code n'est **jamais stocké ni transporté en clair** entre composants : la requête
  n'enregistre qu'un défi ; le code est tiré au sort par le traitement asynchrone qui envoie le
  message. La boîte d'envoi et la file de traitement ne voient que l'identifiant du défi.
- Empreinte par **HMAC-SHA-256** avec une clé absente de la base (`AUTH_CODE_HMAC_SECRET`) :
  un code à six chiffres se retrouverait instantanément à partir d'une empreinte simple.

**Non-divulgation.**

- Inscription avec une adresse déjà prise, renvoi de code, mot de passe oublié : réponse
  identique que le compte existe ou non. Le titulaire d'un compte existant est prévenu par e-mail.
- Connexion : même erreur pour une adresse inconnue et un mot de passe erroné, et même coût
  de calcul (vérification factice). L'état du compte n'est indiqué qu'après un mot de passe correct.
- Les blocages temporaires portent sur l'identifiant présenté, existant ou non.
- Tout refus de code répond `INVALID_OR_EXPIRED_CODE`, sans en préciser la cause.

## Conséquences

- L'envoi étant asynchrone, le temps de réponse ne dépend pas du prestataire d'envoi.
- Si un envoi est rejoué, un nouveau code remplace le précédent : le dernier message fait foi.
- Il subsiste une différence de quelques écritures en base entre « compte existant » et
  « compte inconnu » ; les limites de débit la rendent inexploitable en pratique.
- Un attaquant peut bloquer temporairement la connexion d'un compte en multipliant les échecs ;
  la réinitialisation du mot de passe lève le blocage.
