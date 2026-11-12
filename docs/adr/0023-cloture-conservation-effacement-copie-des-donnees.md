# 0023 — Clôture d'un compte, conservation légale, effacement et copie des données

**Statut :** acceptée (2026-11-12) — durées et étendue des droits à confirmer par un conseil juridique

## Contexte

Jusqu'ici, un compte ne se fermait pas : il pouvait être suspendu, jamais clôturé, et rien de ce
qu'il contenait n'était jamais effacé (ADR 0020 le notait). Deux exigences se croisent :

- **conserver** : la loi n° 22/068 (lutte contre le blanchiment) impose de garder dix ans après
  la fin de la relation les pièces qui ont servi à identifier un client (ADR 0022) ;
- **ne pas conserver davantage** : la protection des données personnelles (Code du numérique,
  ordonnance-loi n° 23/010 du 13 mars 2023) reconnaît à la personne un droit d'accès à ses
  données, un droit à leur effacement et un droit à leur portabilité.

**Limite de cette lecture.** Le texte du Code du numérique n'a pas été lu directement : seulement
un résumé non officiel. Les durées retenues ici, et l'étendue exacte des droits (délais de
réponse, exceptions, formalités préalables auprès de l'autorité de contrôle), **doivent être
confirmées par un conseil juridique avant l'ouverture au public**. Les choix ci-dessous sont
prudents et paramétrés à un seul endroit ; ils ne valent pas avis juridique.

## Décision

### La clôture est immédiate et définitive

- **Par le titulaire** (`POST /me/close`) : il présente à nouveau son mot de passe et — si la
  validation en deux étapes est activée — son second facteur. Une session ouverte ne suffit
  pas : un jeton dérobé ne permet pas de fermer un compte.
- **Par le personnel** (`POST /admin/users/{id}/close`), avec la permission `users.close`
  (administrateurs et conformité) : à la demande du titulaire reçue par un autre canal, ou par
  décision de la plateforme ; justification obligatoire, conservée au journal d'audit, jamais
  communiquée au titulaire. Nul ne clôt ainsi son propre compte.
- Pas de délai de rétractation, pas de réouverture : un compte « en cours de clôture » serait
  un état de plus à protéger, et son titulaire peut se réinscrire aussitôt.
- **Refusée** tant que le compte détient un rôle du back-office (il lui est d'abord retiré, sous
  double validation). Le personnel ne clôt pas non plus un compte dont un dossier de
  vérification attend l'examen : il décide d'abord, pour que la décision soit conservée.

### Ce que devient le compte, dans une seule transaction

1. Une **trace de clôture** (`account_closures`) est écrite : date, origine, auteur, échéances —
   et l'adresse e-mail et le numéro que portait le compte.
2. Le compte perd tout ce qui permettait de s'y connecter ou de l'identifier : mot de passe,
   second facteur, codes de secours, codes à usage unique, sessions, profil déclaré.
3. Sa ligne reste, **sans identifiant** : statut `CLOSED`, adresse factice
   `closed-<id>@closed.invalid` (domaine réservé, RFC 2606), aucun numéro. Elle ne change plus
   jamais. Le journal d'audit et les décisions passées continuent de la désigner.
4. Chaque module qui détient des données du compte y met fin (`AccountDataRegistry`). La
   vérification d'identité : une vérification en vigueur prend fin (`ACCOUNT_CLOSED`) ; un
   dossier jamais examiné — en préparation ou déposé — est effacé avec ses fichiers.

L'adresse, le numéro et la pièce d'identité sont **libres aussitôt** : la même personne peut
ouvrir un nouveau compte, qui n'hérite de rien.

Ce qui suit la transaction — annuler une connexion restée à mi-chemin, supprimer du volume les
fichiers des dossiers effacés — est du **nettoyage** : un échec y est journalisé, sans faire
échouer une clôture déjà définitive. Un fichier resté sur le volume est indéchiffrable : sa clé
a disparu avec sa ligne.

### Conservation légale, puis effacement

- Un compte dont **une décision a été prise sur un dossier de vérification** (accepté, refusé,
  remplacé, retiré) garde ces dossiers et leurs pièces **dix ans après la clôture** — dix années
  civiles, comptées en UTC. Sinon, rien n'est conservé à ce titre.
- La trace de clôture garde l'adresse et le numéro jusqu'à l'**échéance d'effacement** : le
  terme légal s'il y en a un, et jamais moins de **trente jours** après la clôture — le temps,
  pour le titulaire, de contester une clôture qu'il n'aurait pas voulue, et pour le support, de
  retrouver le compte par son ancienne adresse.
- À l'échéance, la purge périodique (ADR 0020) efface les dossiers conservés et leurs fichiers,
  puis l'adresse et le numéro de la trace. Il reste la trace sans identifiant, la ligne du
  compte et le journal d'audit.
- Les événements **publiés** de la boîte d'envoi sont désormais supprimés trente jours après
  leur publication : ils ne servent plus qu'au diagnostic et peuvent désigner un compte.

### La base de données a le dernier mot

Comme pour les rôles (ADR 0018) et les dossiers (ADR 0022), ces règles ne reposent pas sur le
seul code de l'API. La migration `account_closure` fait refuser par PostgreSQL :

- un compte clôturé sans sa trace, ou qui garde un secret, une session, un code, un profil, un
  rôle, une adresse ou un numéro ; une trace sans clôture ; une clôture qui laisse un dossier en
  préparation, en attente ou en vigueur (vérifié à la validation de la transaction) ;
- **toute écriture sur un compte clôturé** — une ligne qu'on lui ajoute dans huit tables, ou le
  compte lui-même (erreur `MGX05`). Une requête en cours au moment de la clôture attend son
  issue, puis est refusée : l'API répond `409`, sans que chaque service ait à y penser ;
- une clôture par un compte qui n'est pas actif ou ne détient pas `users.close` ; une clôture
  antidatée ; une conservation de moins de dix ans lorsqu'un dossier a été examiné ;
- **tout effacement avant le terme légal, lu à l'horloge de la base** : une horloge applicative
  en avance, ou un code fautif, n'effacent rien — l'étape de purge échoue et le signale ;
- la modification ou la suppression d'une trace, hors le constat de son effacement.

### Copie des données

`POST /me/data-export` remet au titulaire, en un document JSON versionné, ce que la plateforme
détient sur lui : compte, profil déclaré, réglages de sécurité, sessions, historique (les 2 000
événements les plus récents), dossiers de vérification.

- Elle rassemble tout ce que le titulaire verrait écran par écran : c'est ce qui en fait une
  cible. Elle exige donc **la même preuve que la clôture**, est limitée à trois par
  vingt-quatre heures, inscrite à l'historique et signalée par e-mail.
- Elle ne contient **ni secret d'authentification, ni le numéro complet d'une pièce d'identité
  (masqué), ni les fichiers** joints aux dossiers (décrits, pas inclus) : une session et un mot
  de passe dérobés ne doivent pas suffire à emporter une pièce d'identité.

## Conséquences

- **Le journal d'audit n'est ni purgé ni anonymisé** (ADR 0020). Après l'effacement, il désigne
  encore le compte par son identifiant technique et garde, pour les événements passés :
  l'adresse IP et l'appareil ; le numéro de téléphone **masqué** (quatre premiers et quatre
  derniers caractères) des vérifications de numéro ; l'empreinte courte des identifiants que le
  personnel a recherchés ; le texte des justifications que le personnel a saisies. Il ne
  contient ni adresse e-mail ni numéro complet, mais ce sont encore des données personnelles :
  sa durée de conservation propre reste à fixer avec le conseil juridique.
- Un événement **abandonné** de la boîte d'envoi (jamais publié malgré les reprises) n'est pas
  purgé : il peut désigner un compte par son identifiant technique, une adresse IP ou un
  appareil, et attend qu'un opérateur le traite.
- Les **sauvegardes** de la base et les journaux applicatifs ne sont pas effacés par l'API :
  leur durée de conservation, à fixer à l'hébergement, borne le délai réel d'effacement.
- La clôture étant définitive, une clôture prononcée par erreur ne se défait pas : le titulaire
  se réinscrit et refait vérifier son identité. La trace et le journal disent qui l'a prononcée.
- La copie ne contient pas les fichiers des pièces : un titulaire qui les demande passe par le
  support, dont la procédure reste à écrire.
- Un compte qui ne peut pas être effacé (stockage des pièces indisponible, par exemple) est
  signalé à chaque passage et **reste en tête de file** ; un passage traite au plus 200 comptes.
  Au-delà de 200 comptes durablement bloqués, les suivants attendraient : l'alerte sur les
  échecs de la purge (`DEPLOYMENT.md`) doit donc être traitée, pas ignorée.
- Les durées (trente jours, dix ans, trois copies par jour) sont des constantes de
  `@mgx/contracts` et de la migration : les changer est une décision, pas un réglage. Allonger
  les dix ans demande une migration ; les raccourcir aussi, et la base refuserait d'ici là.
