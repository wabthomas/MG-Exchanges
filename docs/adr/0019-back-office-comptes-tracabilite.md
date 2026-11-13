# 0019 — Back-office des comptes : actions justifiées, accès journalisés

**Statut :** acceptée (2026-11-12)

## Contexte

Le support doit pouvoir retrouver un compte, le suspendre, fermer ses sessions et, dans le
cas d'un téléphone perdu, retirer son second facteur. Chacun de ces pouvoirs est aussi un
moyen de nuire ou de fuir des données ; le back-office est la cible privilégiée de
l'ingénierie sociale.

## Décision

- **Une permission par action** (`users.read`, `users.suspend`, `users.revoke_sessions`,
  `users.reset_mfa`), vérifiée par la garde commune ; le second facteur est exigé.
- **Toute action porte une justification** (10 à 500 caractères), écrite au journal d'audit
  **dans la transaction** qui applique l'action : pas d'action sans trace, pas de trace sans action.
- **Tout accès aux données d'un compte est journalisé** — chaque recherche (critère, nombre
  de résultats, et seulement une empreinte de l'identifiant saisi, qui peut être celui d'un
  tiers), chaque page de la liste et chaque consultation de fiche. Un parcours systématique
  des comptes se voit.
- **Recherche par identifiant complet** (adresse, numéro, identifiant) : pas de recherche par
  fragment, qui servirait surtout à explorer.
- **L'identifiant recherché voyage dans le corps de la requête** (`POST /admin/users/search`),
  jamais dans l'URL. Les journaux de l'API et ceux du Nginx fourni écartent déjà la chaîne de
  requête ; mais une URL est aussi conservée par des équipements que le projet ne maîtrise
  pas — répartiteur de charge ou pare-feu applicatif de l'hébergeur, proxy d'entreprise,
  historique du navigateur. Une adresse e-mail ou un numéro de téléphone n'ont pas à s'y
  trouver. `GET /admin/users` ne sert qu'à parcourir la liste et refuse tout paramètre
  d'identification.
- **Nul n'agit sur son propre compte**, et agir sur le compte d'un membre du personnel exige
  en plus `roles.manage`.
- **Suspension** : sessions fermées, connexions en attente annulées ; le titulaire est prévenu
  sans que la raison lui soit donnée, sauf demande contraire explicite (`notifyUser: false`,
  pour les cas où le prévenir est interdit). Une réactivation ne ranime aucune session.
- **Retrait du second facteur** : toutes les sessions fermées, titulaire toujours prévenu.
- **Le titulaire voit les interventions du support** dans son historique d'activité, sans
  l'adresse ni l'appareil du membre du personnel.
- **Aucun secret n'est jamais renvoyé** par le back-office.

## Conséquences

- Le journal d'audit grossit d'une ligne par recherche, par page et par consultation : c'est
  le prix de la traçabilité des accès, et un volume négligeable devant celui des opérations.
- La recherche est un `POST` qui ne modifie rien : il n'est ni mis en cache ni rejouable par
  un simple lien, ce qui est ici souhaité.
- La fiche d'un compte reste adressée par son identifiant technique dans l'URL
  (`/admin/users/{userId}`) : un UUID n'apprend rien sur la personne.
- L'API ne vérifie pas l'identité de la personne qui demande au support de retirer un second
  facteur : c'est une **procédure** à écrire avant toute mise en service.
- `notifyUser: false` est un pouvoir sensible (suspendre sans prévenir) : il est tracé, et
  devra sans doute être réservé à un rôle de conformité quand celui-ci existera.
- Le support ne peut pas consulter le journal d'audit ni l'historique d'un compte depuis le
  back-office : ce sera un prochain incrément.
