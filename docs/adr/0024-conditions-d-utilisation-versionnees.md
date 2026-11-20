# 0024 — Conditions d'utilisation versionnées : publication, acceptation, accès conditionné

**Statut :** acceptée (2026-11-13) — le texte des conditions et la règle d'acceptation restent à décider par le propriétaire et son conseil juridique

## Contexte

Jusqu'ici, s'inscrire exigeait `acceptTerms: true` : une case cochée, sans texte ni version. La
colonne `users.terms_accepted_at` ne datait en réalité que la demande d'inscription. On ne
pouvait donc dire ni **quel texte** un compte avait accepté, ni le faire évoluer, ni demander
une nouvelle acceptation.

Deux choses ne sont pas décidées, et ne relèvent pas du code :

- **le texte lui-même** — il revient au propriétaire et à son conseil ;
- **la règle** — un changement du texte impose-t-il à chaque titulaire de l'accepter de
  nouveau, ou suffit-il de le lui signaler ?

Ce lot devait pouvoir être construit, testé et livré sans l'une ni l'autre.

## Décision

### Des versions numérotées, immuables, publiées comme des données

- Les conditions sont **des données, pas du code** : aucun texte ne figure dans le dépôt. Une
  version se publie par le back-office ou par l'outil d'exploitation ; changer le texte ne
  demande aucun déploiement.
- Une version porte un **numéro** (1, 2, 3…, sans trou), un texte en français — **il fait
  foi** — et, facultativement, sa traduction anglaise, entière ou absente ; un résumé de ce qui
  change ; son auteur ; sa date.
- **La version en vigueur est la plus récente**, dès sa publication. Il n'y a ni brouillon, ni
  date d'effet différée, ni retrait.
- **Une version publiée ne change plus jamais.** Corriger un texte, c'est publier la version
  suivante. Ce qu'un compte a accepté reste lisible tel quel, par son numéro.

### La règle se choisit à chaque publication

Chaque version porte sa règle, `requiresAcceptance` :

- `true` : chaque compte doit l'accepter avant de continuer ;
- `false` : elle est seulement signalée comme la version en vigueur.

Un compte **doit accepter** lorsqu'il existe une version qui l'exige et qu'il n'a accepté ni
elle, ni une version publiée depuis. Accepter une version, c'est accepter le texte en vigueur
ce jour-là : il tient lieu de ceux qui l'ont précédé. Une version « pour information » publiée
après une version exigée ne lève donc pas l'obligation née de celle-ci ; l'accepter, elle,
s'en acquitte.

La version 1 exige toujours d'être acceptée : nul n'a pu accepter un texte qui n'existait pas.

La question de fond — faut-il exiger une nouvelle acceptation à chaque changement ? — reste
ainsi **entière et ouverte** : l'API applique ce qui est choisi à chaque publication, sans
présumer de ce que la loi impose.

### S'inscrire, c'est accepter la version en vigueur

- La demande d'inscription désigne le numéro de la version que la personne a eue sous les yeux
  (`acceptedTermsVersion`). Ce n'est pas — ou plus — la version en vigueur :
  `409 TERMS_VERSION_NOT_CURRENT`. **On n'accepte pas un texte qu'on n'a pas pu lire.**
- L'acceptation est enregistrée avec le compte, dans la même transaction. Une inscription qui
  en remplace une autre, restée inachevée à la même adresse, efface l'acceptation du précédent
  demandeur : elle ne vaut pas pour le suivant.
- **Tant qu'aucune version n'est publiée, personne ne s'inscrit** (`503`) : on n'ouvre pas de
  compte sans texte à accepter. Ce contrôle, comme les précédents, ne dépend que de la demande :
  la réponse ne dit rien de l'existence d'un compte (ADR 0016).
- **Une version publiée pendant une inscription la fait refuser, quelle que soit l'adresse.**
  Quand l'adresse est libre ou en attente de vérification, la base refuse l'acceptation d'une
  version dépassée. Quand elle appartient déjà à un compte, rien n'est écrit : le service
  relit donc la version en vigueur dans la transaction, et refuse de la même façon. Sans
  cela, la réponse aurait distingué les deux cas à l'instant d'une publication.
- La colonne `terms_accepted_at` est renommée `registered_at` : elle garde ce qu'elle contenait
  vraiment, la date de la demande.

### Accès conditionné : refus par défaut

Une garde globale, exécutée après l'authentification et les permissions, répond
`403 TERMS_ACCEPTANCE_REQUIRED` à toute route authentifiée d'un compte qui doit accepter —
**sauf** celles qui portent `@AllowBeforeTermsAcceptance()` :

- voir où en est son compte et accepter ; se déconnecter ; changer de mot de passe ; gérer ses
  sessions et sa validation en deux étapes ; lire son historique ;
- **obtenir la copie de ses données et clore son compte** : qui refuse un nouveau texte doit
  pouvoir partir avec ce qui lui appartient.

Une route ajoutée demain est donc fermée sans qu'il faille y penser — comme pour
l'authentification (ADR 0015). Un test recense les routes d'un titulaire et échoue tant
qu'une route nouvelle n'est pas classée.

Ne sont pas concernés : les routes publiques (personne n'y est identifié) et **le back-office**.
Le personnel y agit pour la plateforme, non comme client ; et il doit pouvoir publier une
version corrigée sans avoir à accepter celle qu'elle remplace.

La règle est relue en base **à chaque requête** — une lecture, sans cache : une publication
vaut aussitôt, pour toutes les sessions ouvertes. Un cache ferait gagner une lecture et
obligerait à l'invalider sur chaque instance ; ce n'est pas justifié aujourd'hui.

### Publier : deux chemins, un seul contrat

- **Le back-office** (`POST /admin/terms/versions`) : permission `terms.publish`, que seul
  `super_admin` détient ; validation en deux étapes ; justification obligatoire.
- **L'outil d'exploitation** (`pnpm terms:publish`), sur le serveur, connecté avec le **rôle
  propriétaire** de la base : pour installer la première version avant l'ouverture, ou publier
  sans back-office. La version n'a alors pas d'auteur.

Les deux appliquent le même contrat (`publishTermsVersionRequestSchema`), écrivent par la même
fonction et inscrivent l'acte au journal d'audit, dans la transaction de la publication, avec
la justification et l'empreinte de chaque texte.

**La requête désigne le numéro qu'elle publie** — celui de la version en vigueur, plus un. Une
publication est définitive : envoyée deux fois, ou préparée sur la foi d'un état dépassé, elle
doit être refusée plutôt que créer une version de trop.

### Le texte : conservé à l'octet près, empreinte vérifiée par la base

- Le texte n'est **jamais retouché** : ni espaces retirés, ni fins de ligne converties. Ce qui
  est validé est ce qui est conservé, et ce qui est conservé est ce qui est servi.
- Il doit être de l'**UTF-8 valide** : un fichier enregistré dans un autre encodage est
  refusé, non « réparé » par des caractères de remplacement. Sont aussi refusés un texte blanc,
  un caractère de contrôle autre que le saut de ligne, le retour chariot et la tabulation, et
  une marque d'ordre des octets en tête (l'outil d'exploitation la retire d'un fichier, et le
  dit ; la route la refuse).
- L'API calcule l'**empreinte SHA-256** du texte reçu ; la base la recalcule sur le texte
  qu'elle conserve et refuse la publication si elles diffèrent. L'empreinte est rendue à qui
  publie — pour la comparer à celle du fichier approuvé (`sha256sum`) —, servie avec le texte,
  et consignée au journal d'audit avec chaque acceptation.
- L'API n'interprète pas le texte (brut ou Markdown) : l'afficher est l'affaire du client.

### La base de données a le dernier mot

Comme pour les rôles (ADR 0018), les dossiers (ADR 0022) et la clôture (ADR 0023), la migration
`terms_of_use` fait refuser par PostgreSQL, quel que soit le code qui écrit :

- un numéro qui n'est pas le suivant — les publications sont sérialisées par un verrou ;
- une publication par un compte qui n'est pas actif ou ne détient pas `terms.publish` ; une
  publication sans auteur par un autre rôle que le propriétaire de la base — donc par l'API ;
- toute modification, suppression ou vidage des versions publiées, même par le propriétaire ;
- un texte hors bornes, ou dont l'empreinte n'est pas la sienne ;
- l'acceptation d'une autre version que celle en vigueur, ou par un compte suspendu ou clôturé ;
- la modification d'une acceptation, et sa suppression hors de deux cas : inscription jamais
  vérifiée, clôture dont la trace est déjà écrite ;
- la clôture d'un compte qui garderait une acceptation.

Les dates de publication et d'acceptation sont celles de **l'horloge de la base**. Les
fonctions de la migration ont un chemin de recherche figé : une table temporaire homonyme ne
peut pas répondre à la place des vraies.

Deux erreurs : `MGX06`, règle enfreinte ; `MGX07`, numéro qui n'est pas — ou plus — celui
attendu. La seconde est un cas **attendu** (une version publiée entre la lecture et l'écriture)
et se traduit par un `409` que le client sait traiter.

### Un corps JSON plus volumineux, lu après les gardes

Deux textes de 200 000 caractères dépassent la limite commune des corps de requête (100 Ko),
qui est basse parce que l'analyseur JSON lit le corps **avant** l'authentification. Plutôt que
de relever cette limite pour tous, la route de publication est inscrite dans une liste fermée
(`deferred-json-body.ts`) : l'analyseur commun l'ignore, et elle lit elle-même son corps — un
mébioctet au plus, en trente secondes au plus — **après** l'authentification, les permissions
et les quotas. Nginx lui réserve une limite propre (1 100 Ko).

Les deux limites s'appliquent, en caractères et en octets. Deux textes de la longueur
maximale tiennent dans un mébioctet en français ou en anglais (un à deux octets par
caractère) ; ils n'y tiendraient pas dans une écriture à trois octets par caractère — la
limite serait alors à relever.

### Clôture, purge, copie des données

- La clôture efface les acceptations du compte, comme son profil et ses sessions (ADR 0023) ;
  la purge d'une inscription jamais vérifiée aussi (ADR 0020). `terms_acceptances` rejoint les
  tables auxquelles rien ne s'ajoute pour un compte clôturé (`MGX05`).
- La copie des données (format `2`) liste les versions acceptées et leurs dates.
- Le journal d'audit garde la trace de chaque acceptation : version, empreinte, date, adresse
  IP, appareil.

## Alternatives écartées

- **Le texte dans le dépôt**, livré avec le code. Écarté : le texte n'appartient pas au code,
  le changer exigerait un déploiement, et la preuve de ce qui a été accepté doit vivre avec les
  acceptations.
- **Un réglage global** « toute nouvelle version doit être acceptée ». Écarté : c'est une
  propriété de chaque version — une correction de coquille et un changement de tarifs
  n'appellent pas la même réponse — et la question de fond reste ouverte.
- **Annoncer chaque version par e-mail à tous les titulaires.** Non réalisé. Un envoi en masse
  demande ce que la plateforme n'a pas encore : plafond global d'envoi, exploitation des
  non-remises et des plaintes (`SECURITY.md`, « Prévu »). Le titulaire apprend qu'il doit
  accepter à sa prochaine connexion.
- **Brouillons, date d'effet différée, double validation d'une publication.** Non réalisés :
  chacun ajoute un état à protéger. Une publication est aujourd'hui l'acte d'une seule personne
  habilitée, tracé et justifié.
- **Garder les acceptations après la clôture.** Écarté : la clôture ne laisse au compte aucune
  ligne (ADR 0023) ; la trace utile est au journal d'audit, qui n'est pas purgé.

## Conséquences

- **Changements incompatibles pour les clients de l'API** : à l'inscription,
  `acceptedTermsVersion` remplace `acceptTerms` ; la copie des données passe au format `2`
  (`terms` ajouté, `account.termsAcceptedAt` retiré) ; la fiche d'un compte au back-office porte
  `terms` au lieu de `termsAcceptedAt` ; toute route d'un titulaire peut désormais répondre
  `403 TERMS_ACCEPTANCE_REQUIRED`. Aucun client n'étant en service, la version de l'API (`v1`)
  n'a pas été relevée.
- **La migration n'est pas compatible avec la version précédente de l'API** : elle renomme
  une colonne que celle-ci lit. Contrairement à la règle de `DEPLOYMENT.md` (« étendre,
  migrer, contracter »), il faut arrêter l'API avant de migrer, et revenir à l'image
  précédente n'est plus possible ensuite. Admis parce qu'aucun environnement n'est en
  service ; garder l'ancien nom aurait laissé dans le schéma une colonne qui ne dit pas ce
  qu'elle contient.
- **Avant d'ouvrir l'inscription, publier la version 1** (`DEPLOYMENT.md`) : d'ici là,
  l'inscription répond `503`.
- **Les comptes existants n'ont accepté aucune version.** Dès la publication de la version 1,
  tous devront l'accepter à leur prochaine requête — personnel compris, pour ses routes de
  client. La case cochée à leur inscription n'est pas reprise comme une acceptation : elle ne
  désignait aucun texte.
- **Une publication ne se défait pas.** Un texte publié par erreur reste lisible par son
  numéro ; on publie la version suivante. Il n'y a pas de seconde validation.
- **Une acceptation prouve qu'une requête authentifiée a désigné la version en vigueur**, non
  que la personne a lu le texte : c'est au client de l'afficher avant de proposer de l'accepter.
- Une lecture de plus en base pour chaque requête d'un titulaire sur une route conditionnée.
- Le décompte des acceptations d'une version ne compte que les comptes ouverts (et les
  inscriptions en cours) : la clôture efface les acceptations.
- Les listes rendent les 100 versions les plus récentes, sans pagination ; une version plus
  ancienne reste lisible par son numéro.
- Le journal d'audit garde, pour chaque acceptation, l'adresse IP et l'appareil : ce sont des
  données personnelles, soumises à la même réserve que dans l'ADR 0023.
- Les bornes (200 000 caractères, 1 000 pour un résumé, un mébioctet par requête) sont des
  constantes de `@mgx/contracts` recopiées dans la migration : les changer demande une
  migration. Les tests fixent les unes (`contracts.spec.ts`) et les autres
  (`terms-schema.spec.ts`) aux mêmes valeurs, et l'outil d'exploitation publie un texte de la
  longueur maximale exacte.
