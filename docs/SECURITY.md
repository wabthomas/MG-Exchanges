# Sécurité

Ce document distingue strictement ce qui est **en place et testé** de ce qui est **prévu**.
Rien de ce qui figure dans la seconde catégorie ne doit être considéré comme acquis.

## En place (phases 1 et 2 ; phase 3, lots 1 à 4)

### Configuration et secrets

- Aucun secret dans le dépôt : seuls des modèles `*.env.example` sans valeur sont versionnés ;
  `.env`, clés et certificats sont exclus par `.gitignore`.
- La configuration est validée au démarrage ; un message d'erreur de configuration ne
  contient jamais la valeur d'une variable.
- En production, la configuration provient uniquement de l'environnement du processus
  (gestionnaire de secrets de la plateforme d'hébergement) ; aucun fichier `.env` n'est lu.
- Règles durcies en `staging` et `production`, vérifiées au démarrage : `NODE_ENV=production`,
  journaux JSON, pas de joker CORS, documentation de l'API fermée en production.

### Journaux et audit

- Journalisation structurée avec **expurgation systématique** : toute clé au nom sensible
  (`password`, `token`, `secret`, `authorization`, `cookie`, `otp`, `pin`, `privateKey`,
  `encryptionKey`, `mnemonic`, `cardNumber`, `documentNumber`…) et tout jeton reconnaissable
  (`Bearer …`, JWT) sont remplacés par `[REDACTED]`, à toute profondeur.
- D'une requête HTTP ne sont journalisés que la méthode, le chemin (sans la chaîne de
  requête), l'adresse du client et l'agent utilisateur — ni en-têtes, ni corps.
- Journal d'audit en ajout seul, protégé par la base elle-même (voir `DATABASE.md`) ;
  ses métadonnées sont expurgées avant écriture ; l'entrée d'audit est écrite dans la
  transaction de l'opération auditée.

### Surface HTTP

- En-têtes de sécurité sur toutes les réponses : `Content-Security-Policy` (dont
  `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `Strict-Transport-Security` (2 ans),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` ; `X-Powered-By` supprimé.
- `Cache-Control: no-store` sur toutes les réponses.
- CORS : liste d'origines explicite ; aucune origine autorisée par défaut.
- API JSON uniquement : les corps de formulaire ne sont pas interprétés, ce qui écarte les
  requêtes inter-sites forgées par un simple formulaire. Taille du corps bornée. Une seule
  route reçoit un fichier — une pièce de vérification —, comme corps brut d'un type
  qu'aucun formulaire ne peut produire (voir « Vérification d'identité »).
- **Le corps d'une requête JSON est lu avant l'authentification** — par l'analyseur commun,
  d'où sa limite basse (100 Ko). Une seule route JSON reçoit davantage : la publication des
  conditions d'utilisation (1 Mio). Pour elle, l'analyseur commun ne lit rien ; la route lit
  elle-même son corps **après** l'authentification, le contrôle des droits et les quotas,
  avec une limite de taille et un délai. Un appelant sans droit n'y fait donc lire aucun
  octet de plus qu'ailleurs.
- Validation systématique des entrées par schéma ; propriétés inconnues refusées.
- Erreurs : une erreur inattendue renvoie un message générique ; pile d'appels et message
  interne restent dans les journaux, rattachés à l'identifiant de requête.
- Limitation de débit par adresse IP, compteurs atomiques partagés dans Redis. **Fermée en
  cas de panne** : si Redis est indisponible, la requête échoue plutôt que de passer sans contrôle.
- Adresse du client : `X-Forwarded-For` n'est pris en compte que pour le nombre de proxys de
  confiance configuré (`TRUST_PROXY_HOPS`) ; Nginx écrase la valeur fournie par le client.
- La sonde de disponibilité n'indique que l'état de chaque dépendance (ni adresse, ni version,
  ni message d'erreur) et n'est pas relayée par Nginx.

### Identité et sessions

- **Refus par défaut** : toute route exige une authentification, sauf celles explicitement
  déclarées publiques. Un test compare la liste des routes publiques à une liste fermée :
  en ouvrir une de plus exige de la modifier.
- **Mots de passe** : jamais stockés. Empreinte Argon2id (19 Mio, 2 passes au minimum en
  pré-production et en production — la configuration refuse moins), salée, au format PHC ;
  recalculée à la connexion lorsque les paramètres sont renforcés. Règles de choix conformes
  à NIST SP 800-63B : longueur, pas de règle de composition, refus des mots de passe
  courants, répétitifs ou dérivés de l'identifiant.
- **Jetons de session opaques** (256 bits d'aléa) : seule leur empreinte SHA-256 est stockée.
  Ils ne contiennent aucune information et ne peuvent être ni forgés, ni prolongés — il
  n'existe aucune clé de signature dont le vol permettrait d'usurper un compte. Chaque
  requête vérifie l'état réel de la session et du compte : déconnexion, changement de mot de
  passe et suspension prennent effet immédiatement.
- **Renouvellement avec détection de vol** : le jeton de renouvellement change à chaque
  usage ; la réutilisation d'un jeton déjà remplacé révoque la session entière.
- **Codes à usage unique** : jamais stockés ni transmis en clair entre composants (le code
  est tiré au sort au moment de l'envoi) ; empreinte par HMAC avec une clé absente de la base ;
  5 essais, 15 minutes, 3 codes par quart d'heure et par compte ; un seul code valable à la fois.
- **Aucune divulgation de l'existence d'un compte** : inscription, renvoi de code, mot de
  passe oublié et échec de connexion répondent de la même façon que le compte existe ou non ;
  le coût de calcul est le même dans les deux cas (hachage ou vérification factice).
- **Blocage temporaire** après des échecs de connexion répétés, par (compte, adresse) puis
  par compte ; les compteurs portent sur l'identifiant présenté, existant ou non.
- **Changement de mot de passe** : exige le mot de passe actuel (une session volée ne suffit
  pas), ferme les autres sessions, prévient le titulaire. La réinitialisation ferme toutes
  les sessions.
- **Vérification de l'adresse** : exige le code _et_ le mot de passe de l'inscription. Sans
  cela, un tiers pourrait créer un compte à l'adresse d'une victime avec son propre mot de
  passe, puis attendre qu'elle l'active elle-même. Une nouvelle inscription sur une adresse
  non vérifiée remplace entièrement la précédente ; une inscription jamais vérifiée ne se
  réinitialise pas et disparaît au bout de 7 jours.
- **Autorisations** : permissions relues en base à chaque requête d'administration — le
  retrait d'un rôle est immédiat. Tout refus est inscrit au journal d'audit.
- **Boîte de réception de développement** : interdite en pré-production et en production par
  la validation de la configuration.

### Validation en deux étapes

- **TOTP** (RFC 6238 : SHA-1, 6 chiffres, 30 s, ± 1 pas), vérifié contre les vecteurs des
  RFC 4226 et 6238. **Un code n'est accepté qu'une fois** : rejouer un code intercepté
  échoue, même dans sa fenêtre de validité (contrôle atomique en base).
- **Secret chiffré au repos** : AES-256-GCM, clé hors de la base
  (`AUTH_SECRETS_ENCRYPTION_KEY`), lié au compte par les données authentifiées — un contenu
  chiffré recopié sur un autre compte ne se déchiffre pas. La base refuse tout secret qui
  n'a pas la forme d'un secret chiffré. La lecture de la base seule ne livre aucun secret.
- **Codes de secours** : 10 codes de 50 bits, à usage unique, dont seule l'empreinte HMAC
  est stockée ; remis une seule fois. Leur usage est signalé au titulaire.
- **Connexion en deux temps** : après le mot de passe, **aucune session n'existe** ; un jeton
  de courte durée (5 minutes, 5 présentations, une seule connexion), dont seule l'empreinte
  est conservée, donne accès à la seconde étape et à rien d'autre. Changement de mot de passe,
  suspension, fermeture des sessions par le support : toute connexion en attente est annulée.
- **Essais bornés par compte**, d'où qu'ils viennent : 5 codes erronés en 15 minutes
  (blocage 15 minutes), 20 en 24 heures (blocage 24 heures, non effacé par une connexion
  réussie) — sans cela, un code à six chiffres ne résisterait pas à qui connaît le mot de
  passe. Le blocage est signalé au titulaire : quelqu'un connaît son mot de passe.
- **Ré-authentification** : activer, désactiver le second facteur ou régénérer les codes de
  secours exige de présenter à nouveau le mot de passe (une session volée ne suffit pas) ;
  désactiver et régénérer exigent en plus une preuve du second facteur. Ces essais-là sont
  bornés eux aussi (5 en 15 minutes).
- **Toute modification du second facteur ferme les autres sessions** et prévient le titulaire.
- **Réinitialiser le mot de passe ne retire pas le second facteur** : l'accès à la boîte aux
  lettres ne suffit pas à entrer dans un compte protégé.
- **Le back-office l'exige** : aucune route d'administration ne répond à un compte qui ne l'a
  pas activé, quelles que soient ses permissions.

### Connexions inhabituelles et historique

- Une connexion depuis un **appareil inconnu** du compte est signalée au titulaire par e-mail
  (date, adresse IP, type d'appareil). Le message ne recopie aucun texte libre fourni par
  celui qui se connecte (nom d'appareil, agent utilisateur brut) : dans le cas signalé, ce
  serait un tiers. Seule l'empreinte de l'identifiant d'appareil est conservée.
- **Aucun message ne contient de lien** : on ne clique pas dans un e-mail de sécurité.
- Le titulaire consulte l'**historique des événements de sécurité** de son compte, y compris
  les interventions du support — sans l'adresse ni l'appareil du membre du personnel.

### Envoi des e-mails

- Les e-mails partent par SMTP, sur une **connexion chiffrée** et un **certificat vérifié** :
  la configuration refuse tout autre réglage en pré-production et en production. Avec
  `starttls`, ni les identifiants du compte d'envoi ni un message ne partent tant que la
  connexion n'est pas chiffrée (ADR 0021).
- L'expéditeur n'adresse un message qu'à **une adresse nue** : tout ce qui pourrait désigner
  un second destinataire ou en substituer un autre est refusé avant tout échange, sans
  dépendre de la validation faite à l'inscription.
- Le journal ne contient ni adresse ni contenu : une ligne par message accepté (modèle,
  identifiant), et les réponses du serveur adresses masquées.
- Les messages sont en texte seul, sans lien ni pièce jointe, et marqués comme automatiques.
- **Limites** : pas de plafond global d'envoi (seules les limites par adresse IP et par
  compte s'appliquent) ; les retours de non-remise et les plaintes ne sont pas exploités.

### Vérification d'identité (KYC)

Les pièces d'identité sont les données les plus sensibles que la plateforme détient à ce
jour. Décisions et limites : ADR 0022.

- **Jamais en clair au repos.** Chaque fichier est chiffré (AES-256-GCM) avec une clé qui lui
  est propre ; cette clé, chiffrée par une clé maîtresse (`KYC_ENCRYPTION_KEY`), est en base.
  Le fichier chiffré est sur un volume distinct. Lire une pièce exige **le volume, la base et
  la clé maîtresse** ; aucune de ces trois fuites, seule, ne livre un document. Le numéro de
  la pièce d'identité est chiffré en base ; les doublons se détectent sur une empreinte à
  clé, sans rien déchiffrer.
- **Contenu lié à sa place.** L'identifiant de la pièce, son dossier et sa nature sont
  authentifiés avec le contenu : un fichier ou une clé recopiés à la place d'un autre ne se
  déchiffrent pas. À chaque relecture, l'empreinte du fichier reçu est vérifiée ; une pièce
  altérée ou disparue n'est pas rendue, et l'incident est tracé.
- **Clé dédiée.** `KYC_ENCRYPTION_KEY` doit différer de la clé des secrets de connexion (la
  configuration refuse qu'elles soient identiques) ; chaque usage en dérive sa propre
  sous-clé. Sans clé ou sans volume, la vérification répond `503` : il n'existe aucun mode
  dégradé « sans chiffrement ».
- **Envoi d'un fichier.** Type lu sur les premiers octets (JPEG, PNG, PDF) et confronté au
  type annoncé ; taille de 1 Ko à 5 Mio. Le corps n'est lu qu'après l'authentification, le
  quota du compte et le contrôle du dossier : le contenu d'un envoi irrecevable n'est jamais
  gardé en mémoire. La réception est bornée en taille, en durée (2 minutes) et en nombre (8 à
  la fois par instance, 4 par adresse IP au niveau du proxy, 40 par heure et par compte).
- **Rien n'est servi au titulaire.** Une pièce envoyée ne se retélécharge pas par l'API
  cliente, et le numéro de la pièce n'est rendu que masqué : une session volée ne donne pas
  accès aux documents du compte.
- **Rien en clair sur le disque du proxy.** Une pièce y transite au fil de l'eau à l'envoi, et
  depuis la mémoire au téléchargement par un examinateur : Nginx n'écrit aucun fichier
  temporaire, dans un sens comme dans l'autre (vérifié sur la pile complète).
- **Examen cloisonné.** Seuls les détenteurs de `kyc.read` voient les dossiers — et
  uniquement ceux qui ont été déposés. Le rôle `support` n'y a pas accès ; le rôle
  `compliance` ne suspend ni ne déconnecte un compte, et ne touche pas à son second facteur :
  il peut seulement le clore (ADR 0023). **Nul n'examine son propre dossier.**
- **Tout accès est tracé avant d'être servi** : chaque page de la file, chaque fiche, chaque
  téléchargement, avec son auteur. Une pièce n'est rendue qu'en pièce jointe (`attachment`,
  `nosniff`) : le navigateur d'un examinateur ne l'interprète pas comme une page.
- **Le parcours est imposé par la base** (voir `DATABASE.md`) : un dossier déposé est une
  preuve qui ne se modifie plus ; une décision ne vient que d'un compte actif habilité, jamais
  du titulaire ; une même pièce d'identité ne vérifie qu'un seul compte. La même limite que
  pour les rôles s'applique : la base vérifie la qualité de l'examinateur que l'API lui
  désigne, pas sa présence.
- **Le titulaire n'apprend que ce qui le concerne** : les motifs d'un refus, jamais la note
  interne, ni l'identité de l'examinateur, ni le motif d'un retrait.
- **Minimisation.** Un dossier jamais déposé est effacé, avec ses pièces, après trente jours.
  Rien de la déclaration ni des pièces n'est écrit dans les journaux ni dans le journal
  d'audit (qui retient les identifiants, la nature et le format des pièces, leur taille).

> **Limites à connaître avant toute ouverture.**
>
> - **L'examen est entièrement humain** : rien ne lit la pièce, ne compare l'autoportrait, ni
>   ne consulte une liste de sanctions ou de personnes politiquement exposées.
> - **Aucune analyse antivirus.** Le contenu d'un fichier n'est contrôlé que par sa
>   signature : un PDF ou une image piégés seraient acceptés, puis ouverts par un
>   examinateur. Son poste doit être protégé en conséquence (visionneuse isolée, système à
>   jour), ou une analyse ajoutée avant l'ouverture au public.
> - **La clé maîtresse n'est ni sauvegardée ni renouvelée par l'application.** Perdue, toutes
>   les pièces sont illisibles ; compromise avec la base et le volume, toutes sont lisibles.
>   Elle se conserve à part des sauvegardes de la base et du volume.
> - **Un examinateur habilité peut télécharger toutes les pièces déposées.** Chaque accès est
>   tracé, mais rien ne plafonne ni ne signale un volume anormal de consultations.
> - **Une pièce est tenue en mémoire, en clair, le temps de sa réception** et de son
>   chiffrement : jusqu'à 20 Mio par envoi en cours (la pièce, sa version assemblée et ses
>   copies chiffrées), huit envois à la fois — soit 160 Mio au plus par instance, à prévoir
>   dans la mémoire allouée à l'API.
> - Les métadonnées d'une image (lieu, appareil) ne sont pas retirées : la pièce est
>   conservée telle que reçue, comme preuve.

### Téléphone

- Le numéro ne devient celui du compte qu'après confirmation d'un code reçu par SMS ; un
  numéro vérifié n'appartient qu'à un compte (contrainte en base), et seul le détenteur du
  numéro peut apprendre qu'il est déjà utilisé.
- Les SMS ne partent que vers les mobiles des pays desservis (pas de numéro surtaxé à
  l'étranger), et sont bornés par compte et par numéro.

### Back-office

- **Aucune élévation de privilège par l'API** : le rôle PostgreSQL de l'API ne peut pas
  écrire dans les tables de rôles, de permissions ni d'attributions. Les premiers
  administrateurs sont créés en ligne de commande, avec le rôle propriétaire de la base, et
  l'opération est tracée.
- **Double validation des rôles, imposée par la base de données.** Un rôle n'est attribué ou
  retiré que par l'approbation d'une demande ; c'est un déclencheur PostgreSQL qui applique
  le changement, après avoir vérifié lui-même que l'approbateur n'est ni l'auteur de la
  demande ni l'intéressé, que tous deux sont actifs et détiennent `roles.manage`, que la
  demande n'est ni échue ni modifiée, et qu'un rôle ne va qu'à un compte actif. Les
  approbations sont appliquées une à une : deux approbations simultanées ne peuvent pas se
  retirer mutuellement un intervenant. Une demande décidée ne se modifie ni ne s'efface. Un
  défaut du code de l'API ne permet donc pas à une personne seule de s'attribuer un rôle.
  **Limite** : la base vérifie la qualité des deux intervenants que l'API lui désigne, pas
  leur présence. Elle ne protège pas d'un attaquant qui exécuterait du SQL arbitraire sous le
  rôle de l'API ; elle garantit seulement qu'il laisserait une trace ineffaçable (ADR 0018).
- **Séparation du support et de l'administration** : le rôle `support` trouve les comptes,
  les suspend et ferme leurs sessions ; il ne retire pas un second facteur, ne clôt aucun
  compte, ne gère pas les rôles et **n'agit pas sur les comptes du personnel**. Nul n'agit sur
  son propre compte.
- **Toute action est justifiée et tracée** dans la transaction qui l'applique ; **tout accès
  aux données d'un compte l'est aussi** (recherches, pages de la liste, consultations). Le
  journal ne retient qu'une empreinte de l'identifiant recherché.
- **Recherche par identifiant complet uniquement** : pas d'exploration par fragment.
- **Aucun identifiant personnel dans une URL.** L'adresse ou le numéro recherché voyage dans
  le corps d'une requête `POST`. Les journaux de l'API et du Nginx fourni écartent la chaîne
  de requête, mais une URL est aussi conservée par ce que le projet ne maîtrise pas :
  équipements de l'hébergeur, proxy d'entreprise, historique du navigateur. La liste des
  comptes n'accepte en paramètre que le statut et la pagination.
- **Suspension** : sessions fermées, connexion refusée, connexions en attente annulées ; une
  réactivation ne ranime aucune session. Le message au titulaire ne donne jamais la raison,
  et peut être omis (`notifyUser: false`) lorsqu'une obligation de confidentialité l'impose.

> **Retrait du second facteur par le support — procédure à définir avant toute mise en
> service.** C'est le chemin d'attaque classique (se faire passer pour un titulaire qui a
> « perdu son téléphone »). L'API borne le risque — permission réservée, justification,
> fermeture des sessions, message au titulaire — mais **ne vérifie pas l'identité du
> demandeur** : cela relève d'une procédure du support (pièce d'identité, délai de
> carence, rappel sur le numéro vérifié…) qui n'est pas encore écrite.

### Clôture, copie et effacement des données

Décisions et limites : ADR 0023.

- **Preuve du titulaire.** Clore son compte ou en demander la copie exige de présenter à
  nouveau le mot de passe et — si elle est activée — la validation en deux étapes. Un jeton
  dérobé n'y suffit pas ; le seul mot de passe d'un compte protégé non plus. Les essais erronés
  sont bornés, tracés et visibles dans l'historique du compte.
- **Une clôture ne laisse rien d'utilisable.** Dans une seule transaction, le mot de passe, le
  second facteur, les codes de secours, les codes à usage unique, les sessions et le profil
  sont supprimés, et le compte ne porte plus ni adresse ni numéro. Les jetons en circulation
  cessent de valoir aussitôt ; une connexion restée à mi-chemin (seconde étape) n'aboutit
  plus ; l'ancienne adresse reçoit la réponse d'une adresse inconnue, et « mot de passe
  oublié » n'envoie rien.
- **La base de données refuse toute écriture sur un compte clôturé** (erreur `MGX05`), y
  compris celle d'une requête partie avant la clôture : elle attend l'issue de la clôture,
  puis échoue (`409`). Un service qui l'oublierait — aujourd'hui ou demain — ne peut pas
  ranimer un compte ni lui rattacher une donnée.
- **Rien n'est réattribué.** L'adresse, le numéro et la pièce d'identité redeviennent libres,
  mais le compte ouvert ensuite avec eux est un autre compte : il ne voit ni l'historique, ni
  les sessions, ni les dossiers de l'ancien.
- **La conservation légale est imposée par la base.** Les dossiers de vérification sur
  lesquels une décision a été prise ne s'effacent pas avant dix ans : la base lit l'échéance
  **à sa propre horloge**, pas à celle de l'application. Une horloge applicative en avance ou
  un défaut du code n'effacent rien : l'étape de purge échoue et le signale. Un dossier jamais
  examiné, lui, est effacé à la clôture, fichiers compris.
- **La trace d'une clôture ne se réécrit pas** : ni modification, ni suppression, ni vidage de
  la table — seul le constat de son effacement, une fois, à l'échéance.
- **Clôture par le personnel** : permission `users.close` (administrateurs et conformité),
  que la base vérifie elle aussi ; motif et justification au journal d'audit, dans la
  transaction ; titulaire toujours prévenu, jamais de la raison ; jamais sur son propre
  compte, jamais sur un compte qui détient un rôle.
- **Copie des données** : aucun secret, numéro de pièce masqué, **aucun fichier** — une
  session et un mot de passe dérobés ne suffisent pas à emporter une pièce d'identité. Trois
  copies au plus par vingt-quatre heures ; chacune est tracée et signalée au titulaire par
  e-mail, avec l'adresse IP d'origine.

> **Limites à connaître.**
>
> - **La lecture de la loi n'est pas confirmée.** Dix ans de conservation, trente jours avant
>   l'effacement des identifiants, étendue des droits d'accès et d'effacement : ces choix
>   s'appuient sur notre lecture de la loi n° 22/068 et sur un **résumé non officiel** du Code
>   du numérique. Un conseil juridique doit les valider avant l'ouverture au public.
> - **Une personne habilitée suffit à clore un compte**, définitivement : il n'y a pas de
>   double validation, à la différence des rôles. Le journal dit qui, quand et pourquoi.
> - **Le journal d'audit n'est pas effacé** : il garde l'identifiant technique du compte,
>   l'adresse IP et l'appareil des événements passés, le numéro masqué des vérifications de
>   téléphone, l'empreinte des identifiants recherchés par le personnel et le texte de ses
>   justifications. Ni adresse e-mail, ni numéro complet.
> - **Sauvegardes et journaux applicatifs** échappent à l'API : leur durée de conservation, à
>   fixer à l'hébergement, borne le délai réel d'effacement.
> - **L'échéance d'effacement d'un compte sans conservation légale se lit à l'horloge de
>   l'application** : seule la conservation légale est relue par la base.

### Conditions d'utilisation

Décisions et limites : ADR 0024.

- **Une version publiée ne change plus.** Ni modification, ni suppression, ni vidage de la
  table : la base le refuse, même au propriétaire du schéma. Ce qu'un compte a accepté reste
  lisible tel quel, par son numéro.
- **Le texte conservé est le texte soumis, à l'octet près.** Rien n'est retouché — ni espaces,
  ni fins de ligne. L'API calcule l'empreinte SHA-256 du texte reçu ; la base la recalcule sur
  le texte qu'elle conserve et refuse la publication si elles diffèrent. Un texte mal encodé
  (UTF-8 invalide) est refusé, non « réparé ». L'empreinte est rendue à qui publie, pour être
  comparée à celle du fichier approuvé, et servie avec le texte à qui le lit.
- **La numérotation est tenue par la base** : une publication à la fois, seul le numéro
  suivant se publie. Une requête rejouée, ou préparée sur un état dépassé, est refusée au lieu
  de créer une version de trop.
- **Qui publie** : un membre du personnel actif détenant `terms.publish` — permission que seul
  `super_admin` détient —, avec la validation en deux étapes, comme pour tout le back-office.
  La base relit ce droit au moment de publier. Une version **sans auteur** ne s'écrit qu'avec
  le rôle propriétaire de la base (outil d'exploitation `terms:publish`) : l'API, elle, ne le
  peut pas. Dans les deux cas l'acte est au journal d'audit, avec sa justification et les
  empreintes, dans la transaction de la publication.
- **On n'accepte que la version en vigueur, celle qu'on a pu lire.** L'inscription et
  l'acceptation désignent le numéro du texte présenté ; la base refuse tout autre numéro, y
  compris quand une version est publiée entre la lecture et l'écriture. Une inscription que
  croise une publication est refusée (`409`) de la même façon que l'adresse soit libre, en
  attente de vérification ou déjà prise : la réponse ne dit toujours rien de l'existence
  d'un compte.
- **Une acceptation est une preuve** : datée par la base, elle ne se modifie pas et ne
  s'efface qu'avec le compte (inscription jamais vérifiée, clôture). Le journal d'audit garde,
  pour chaque acceptation, la version, l'empreinte du texte en vigueur, la date, l'adresse IP
  et l'appareil — y compris après la clôture.
- **Refus par défaut.** Tant qu'un compte doit accepter, toute route authentifiée lui est
  fermée (`403 TERMS_ACCEPTANCE_REQUIRED`), sauf celles qui déclarent explicitement rester
  ouvertes : voir où il en est, accepter, sécuriser son compte, emporter ses données, le
  clore. Une route ajoutée demain est fermée sans qu'il faille y penser ; un test échoue tant
  que chaque route d'un titulaire n'est pas classée d'un côté ou de l'autre.
- **Refuser les conditions ne retient personne** : la copie des données et la clôture restent
  ouvertes.
- La règle est recalculée **à chaque requête**, sans cache : une publication vaut aussitôt,
  pour toutes les sessions ouvertes.
- La lecture des textes est publique (on doit pouvoir lire avant de s'inscrire), bornée à 60
  requêtes par minute et par client.

> **Limites à connaître.**
>
> - **Le texte et la règle ne sont pas décidés ici.** Aucun texte n'est fourni : il revient au
>   propriétaire et à son conseil. Faut-il exiger une nouvelle acceptation à chaque
>   changement ? L'API applique la règle choisie à chaque publication (`requiresAcceptance`) ;
>   elle ne dit pas laquelle est juridiquement requise.
> - **Une personne habilitée suffit à publier**, définitivement : pas de double validation.
>   Une publication erronée ne se retire pas ; elle se corrige par la version suivante.
> - **Une acceptation prouve qu'une requête authentifiée a désigné la version en vigueur** —
>   pas que la personne a lu le texte. C'est au client (web, mobile) de l'afficher avant de
>   proposer de l'accepter.
> - **Aucun e-mail n'annonce une nouvelle version** : le titulaire l'apprend à sa prochaine
>   connexion. Si la loi ou le texte lui-même impose un préavis, il reste à organiser.
> - **Le personnel n'est pas arrêté dans le back-office** s'il n'a pas accepté lui-même : il y
>   agit pour la plateforme. Ses propres routes de client, elles, lui sont fermées comme à tous.
> - **La base vérifie la qualité de l'auteur que l'API lui désigne**, non que c'est bien lui
>   qui agit : même limite que pour les rôles (ADR 0018).
> - **Comptes existants.** Les comptes ouverts avant ce lot n'ont accepté aucune version : dès
>   la publication de la version 1, tous devront l'accepter — personnel compris, pour ses
>   routes de client. La date d'« acceptation » qu'ils portaient jusque-là n'était que celle de
>   leur inscription (case cochée, sans texte) : elle est conservée comme date d'inscription,
>   pas comme acceptation.

### Grand livre

Décisions et limites : ADR 0025 et 0030. Ce qui suit vaut pour **toute** opération, présente
ou à venir : aucune ne peut l'enfreindre. Deux existent à ce jour — le transfert entre
titulaires et l'ajustement du personnel —, décrites aux sections suivantes.

- **Un solde ne s'écrit pas, il résulte d'écritures.** Chaque écriture a au moins deux
  lignes, et pour chaque actif ses débits égalent ses crédits : la base le vérifie à la
  validation de la transaction, et refuse une écriture incomplète ou déséquilibrée. Rien ne
  s'ajoute ensuite à une écriture validée.
- **Rien ne se modifie ni ne s'efface** : ni un actif, ni une écriture, ni une ligne, ni un
  type de compte ; un compte ne se supprime pas. La base le refuse, même au propriétaire du
  schéma. Une erreur se corrige par une écriture inverse, qui reste visible.
- **Aucun solde ne devient négatif**, celui d'un titulaire comme celui de la plateforme. Le
  contrôle se fait ligne après ligne, sous le verrou du compte : un découvert, même passager
  au sein d'une écriture, est refusé.
- **Un solde écrit directement n'est jamais validé.** Le rang d'une ligne et le solde qui en
  résulte sont calculés par la base ; à la validation de toute transaction qui a touché un
  compte, son solde doit être celui de sa dernière ligne. Le rôle de l'API a techniquement le
  droit de mettre à jour un compte — sans quoi il ne pourrait pas le verrouiller —, mais un
  solde qu'il écrirait lui-même est refusé, et un compte dont le solde ne correspond plus à
  sa dernière ligne n'accepte plus aucune ligne.
- **Aucune écriture hors d'une opération que la base connaît.** La base tient la liste des
  types d'écriture — trois à ce jour — et refuse toute écriture d'un autre type, quels que
  soient le rôle qui écrit et l'auteur qu'elle désigne ; chaque type de la liste n'est validé
  qu'avec son opération : son transfert, ou son ajustement approuvé. Une écriture équilibrée
  d'un type inventé, écrite en SQL sous le rôle de l'API, ne crédite donc plus un
  portefeuille depuis le compte de conservation, ni ne déplace de fonds d'un portefeuille à
  un autre hors des règles des transferts (ADR 0030). La liste ne s'étend que par migration :
  le rôle de l'API ne fait que la lire, et un type ne se modifie ni ne se retire.
- **Un montant n'a de sens que dans son actif** : une ligne est dans l'actif de son compte,
  et l'équilibre se vérifie actif par actif. Les montants sont des entiers d'unités
  minimales, jamais des nombres à virgule (ADR 0007).
- **Idempotence.** Chaque écriture porte une clé unique : la repasser rend le résultat
  d'origine sans rien écrire, y compris quand plusieurs requêtes identiques arrivent
  ensemble ; présenter une autre écriture sous la même clé est refusé.
- **Écritures simultanées.** Les comptes d'une écriture sont verrouillés dans un ordre
  unique avant que les soldes ne soient lus : deux écritures qui se disputent un compte
  passent l'une après l'autre, la seconde à partir du solde laissé par la première, et un
  compte n'est jamais dépensé deux fois. Une transaction que PostgreSQL annule parce qu'elle
  en croisait une autre est relancée, un nombre borné de fois ; au-delà, la requête répond
  `409` — rien n'est écrit à moitié.
- **Un compte clôturé ne reçoit plus rien, un compte qui détient des fonds ne se clôt pas.**
  Une écriture et la clôture de son titulaire s'excluent : l'une attend l'autre, puis en voit
  le résultat.
- **Qui enregistre un actif** : un membre du personnel actif détenant `ledger.manage_assets`
  — que seul `super_admin` détient —, avec la validation en deux étapes ; la base relit ce
  droit au moment d'écrire, et la justification est au journal d'audit, dans la même
  transaction. Sans auteur, un actif ne s'enregistre qu'avec le rôle propriétaire de la
  base : l'API ne le peut pas.
- **Consulter le grand livre est tracé** : chaque liste d'actifs, page de comptes, relevé
  d'un compte, écriture et balance lus par le personnel est inscrit au journal d'audit, avec
  son auteur. La permission `ledger.read` n'est détenue que par `super_admin`.
- **Un titulaire ne lit que ses portefeuilles** : chaque lecture est filtrée par le compte
  de la session, jamais par un paramètre de la requête.
- **Vérification toutes les heures.** Tout le grand livre est relu et recalculé : soldes,
  enchaînement des lignes, écritures, équilibre de chaque actif. Une anomalie — qui ne peut
  venir que d'une altération faite hors de ces règles — est journalisée et inscrite au
  journal d'audit ; les messages ne contiennent que des identifiants, jamais de montant.
  **Rien n'est corrigé automatiquement.**
- **Les références d'une écriture sont bornées** : des textes ASCII courts (identifiants,
  codes), des entiers, des booléens — ni texte libre long, ni structure imbriquée, 2 048
  octets au plus. Une écriture ne s'efface jamais : **aucune donnée personnelle ne doit y
  figurer**. Le format rend la règle difficile à enfreindre par mégarde ; il ne l'impose
  pas, et elle reste à la charge du code de chaque opération.
- Les fonctions de la base ont un chemin de recherche figé : une table temporaire homonyme
  placée par une session ne peut ni habiliter un intrus, ni créer de fonds.

> **Limites à connaître.**
>
> - **Ni dépôt, ni retrait par un titulaire.** Par l'API, des fonds n'entrent dans un
>   portefeuille, et n'en sortent, que par un ajustement du personnel, sous double validation
>   (voir « Opérations du personnel ») : ce que le grand livre crédite alors, c'est ce que
>   deux personnes disent avoir reçu — rien ne le rapproche encore de ce que la plateforme
>   détient réellement. Les garanties ci-dessus sont vérifiées par des tests, pas par un usage
>   réel.
> - **Le grand livre est cohérent avec lui-même ; il ne prouve pas que les fonds existent.**
>   Le rapprochement avec ce que détiennent réellement la banque, l'opérateur de monnaie
>   mobile ou le dépositaire reste à construire, avec les dépôts et les retraits.
> - **Le propriétaire du schéma peut tout** : désactiver un déclencheur, puis altérer une
>   ligne. La vérification périodique est là pour le relever ; elle ne l'empêche pas. Les
>   identifiants du rôle propriétaire ne doivent servir qu'aux migrations.
> - **La liste des types d'écriture vaut pour ce qui s'écrit depuis qu'elle existe.** Une
>   écriture d'un autre type passée auparavant reste dans le grand livre — elle ne s'efface
>   pas — ; la base d'aperçu en porte une, la production n'a jamais servi. **La vérification
>   horaire la signale, à chaque passage** : elle relit le type de chaque écriture et son
>   lien à son opération. Elle relève après coup ; elle n'empêche rien, et **elle ne relit
>   pas ce qui dépendait du moment** — plafonds et niveau à l'heure d'un transfert,
>   permissions à l'heure d'une approbation, gel alors en vigueur.
> - **Un type ajouté à la liste sans la règle qui le lie à son opération rouvrirait le
>   chemin** : rien dans la base ne l'empêche. Par migration, deux tests le gardent pour les
>   types présents — l'un lit les règles, l'autre exige que la vérification horaire relève
>   une écriture de ce type sans son opération. **À la main, par le propriétaire, rien ne le
>   relève** : la vérification tient pour connu tout type de la liste.
> - **Une anomalie n'alerte personne** : elle est journalisée et tracée, mais aucune alerte
>   n'est encore branchée (phase 9), et les opérations ne sont pas suspendues
>   automatiquement.
> - **Une personne habilitée suffit à enregistrer un actif**, définitivement : pas de double
>   validation. Un nombre de décimales erroné ne se corrige pas ; l'actif doit être
>   enregistré sous un autre code.
> - **Les écritures ne s'effacent jamais**, y compris après la clôture d'un compte. Pendant
>   dix ans, l'adresse et le numéro gardés par la trace de la clôture permettent de les
>   rattacher à une personne ; ensuite, elles demeurent sans plus désigner personne. Cette
>   durée s'appuie sur une lecture non confirmée de la loi (ADR 0022 et 0023).
> - **Le journal d'audit garde les consultations du personnel**, avec l'identifiant du
>   titulaire dont le compte a été consulté.

### Transferts entre titulaires

Décisions et limites : ADR 0026.

- **Fermés par défaut, trois fois.** Un transfert n'aboutit que si l'actif est enregistré, si
  des plafonds y sont fixés pour le niveau de vérification de l'émetteur **et** pour celui du
  destinataire, et si la fonctionnalité est ouverte — trois décisions du back-office, chacune
  inscrite au journal d'audit avec son auteur et sa justification. **Aucun plafond n'est
  livré avec le code.**
- **Une session ne suffit pas.** Chaque transfert exige de nouveau le mot de passe et, si la
  validation en deux étapes est activée, un code de l'application ou un code de secours —
  vérifiés **avant tout examen de la requête**. Les essais erronés sont comptés comme
  ailleurs, et inscrits à l'historique du compte.
- **Une requête renvoyée ne transfère pas deux fois.** La clé d'idempotence est obligatoire,
  et unique par émetteur **dans la base** : huit requêtes identiques envoyées ensemble font
  un seul transfert, que toutes rendent. Une autre requête sous la même clé est refusée. Une
  clé ne vaut que pour le compte qui la présente : elle ne donne accès à aucun transfert
  d'un autre. Rejouer exige la preuve du titulaire, comme transférer.
- **Les plafonds sont imposés deux fois** : par l'application, pour répondre clairement ; par
  la base, quel que soit le code qui écrit. La base recalcule elle-même le niveau de
  vérification de l'émetteur et le cumul de ses envois, à sa propre horloge, sous un verrou
  qui fait passer ses transferts un à un : six transferts envoyés ensemble ne dépassent pas
  un plafond. Un transfert ne se modifie ni ne s'efface — on ne libère pas un plafond en
  retirant un envoi.
- **Un transfert et son écriture vont ensemble** : la base refuse, à la validation de la
  transaction, un transfert dont l'écriture n'est pas exactement la sienne, et une écriture
  de transfert sans transfert. Aucun mouvement de ce type n'échappe donc aux plafonds.
- **Jamais plus que ce que le portefeuille détient** : le grand livre refuse tout découvert,
  sous le verrou du compte — y compris quand plusieurs transferts partent ensemble.
- **La route ne dit pas quelles adresses ont un compte.** Adresse inconnue, compte suspendu,
  clôturé, pas encore vérifié, portefeuille gelé, niveau fermé : **le même refus, mot pour
  mot**. Il vient en
  dernier — après la preuve du titulaire, les plafonds et les fonds — et il est compté : le
  dixième en 24 heures suspend les transferts du compte pendant 24 heures.
- **Ce que voit l'autre partie** : l'adresse e-mail que porte aujourd'hui le compte, et rien
  d'autre — ni nom, ni identité vérifiée, ni niveau, ni solde. Après la clôture d'un compte,
  l'autre partie garde le transfert, sans l'adresse.
- **Un titulaire ne lit que ses transferts** : ceux qu'il a envoyés ou reçus. Pour tout autre
  compte, un transfert n'existe pas (`404`).
- **Les deux parties sont prévenues par e-mail.** Le message de l'émetteur dit quoi faire
  s'il n'est pas l'auteur du transfert.
- **Bornes** : 60 demandes par minute et par adresse IP ; 30 transferts tentés par heure et
  par compte, aboutis ou refusés — chaque transfert abouti envoie un message au
  destinataire, et la borne empêche d'en faire un moyen de harcèlement.
- **Suspension et clôture.** Un compte suspendu n'envoie ni ne reçoit rien. Un transfert et
  la suspension ou la clôture de son émetteur s'excluent : l'un attend l'autre, puis en voit
  le résultat. Il en va de même de la clôture du destinataire. La suspension du
  destinataire, elle, n'attend pas : un transfert déjà en cours à cet instant aboutit, le
  suivant est refusé — les fonds reçus restent sur un compte qui ne peut plus rien envoyer.
- **Tout est tracé** : chaque transfert, chaque refus — avec son motif, l'actif, le montant
  et, s'il existe, le compte visé — et chaque preuve refusée sont inscrits au journal
  d'audit, et figurent dans l'historique que le titulaire consulte. **L'adresse saisie pour
  un destinataire refusé n'est pas conservée** : elle peut être celle de n'importe qui.
- **Qui fixe les plafonds** : un membre du personnel actif détenant `transfer_limits.write` —
  que seul `super_admin` détient —, avec la validation en deux étapes ; la base relit ce
  droit au moment d'écrire. Les plafonds remplacés, les nouveaux et la justification sont au
  journal d'audit, dans la même transaction. Des plafonds ne se suppriment pas. Sans auteur,
  ils ne se fixent qu'avec le rôle propriétaire de la base : l'API ne le peut pas. Les
  consulter depuis le back-office est tracé aussi.
- **Ni adresse ni texte dans le grand livre** : l'écriture d'un transfert ne porte que des
  identifiants — celui du transfert, celui du compte qui l'a demandé, celui de la requête.

> **Limites à connaître.**
>
> - **Aucun usage réel** : les fonds qu'un transfert déplace ne peuvent venir que d'un
>   ajustement du personnel, fermé par défaut. Ces garanties sont vérifiées par des tests —
>   dont un parcours complet à travers le proxy, d'un crédit sous double validation jusqu'au
>   transfert —, pas par un usage.
> - **Un transfert est définitif.** Ni annulation, ni délai de rétractation, ni liste de
>   bénéficiaires, ni confirmation d'un nouveau destinataire : des fonds envoyés à une
>   mauvaise adresse — si elle a un compte — ne reviennent que si le destinataire les
>   renvoie. **Qui détient le mot de passe d'un compte sans validation en deux étapes peut en
>   vider le portefeuille, dans la limite des plafonds** : pour un titulaire, le second
>   facteur reste facultatif. Les plafonds sont le seul frein.
> - **Aucune valeur de plafond n'a été validée** : elles sont à fixer par le propriétaire,
>   avec la conformité. Une valeur saisie par erreur prend effet aussitôt.
> - **Une personne habilitée suffit à changer des plafonds** : pas de double validation.
> - **Les plafonds ne portent que sur les envois, actif par actif.** Rien ne borne ce qu'un
>   compte reçoit, ni le total de ses envois tous actifs confondus, ni ce qu'il envoie à un
>   même destinataire. Aucune surveillance des transactions, aucun filtrage (sanctions,
>   personnes politiquement exposées) : phase 8.
> - **Sonder des adresses reste possible, lentement** : neuf refus par 24 heures et par
>   compte ne suspendent rien. Chacun demande la preuve du titulaire, un niveau ouvert et des
>   fonds suffisants pour le montant demandé.
> - **L'adresse e-mail de l'émetteur est montrée au destinataire**, dans l'API et dans le
>   message qu'il reçoit. C'est à dire aux titulaires, dans les conditions d'utilisation ou
>   la politique de confidentialité.
> - **Les messages informent, ils ne garantissent rien** : sans serveur d'e-mail configuré,
>   ils ne partent pas, et le transfert a lieu quand même.
> - **La clé d'idempotence est conservée avec le transfert, indéfiniment.** Elle est choisie
>   par le client : il ne doit y mettre qu'une valeur aléatoire, jamais une donnée
>   personnelle.
> - **Pas de fonds réservés** : un transfert a lieu entièrement, ou pas du tout. Les
>   opérations en plusieurs temps (retrait en attente, séquestre) restent à construire.

### Opérations du personnel : ajustements et gels

- **Aucune personne seule ne crédite ni ne débite un portefeuille.** Un ajustement est
  demandé par un membre du personnel et approuvé par un autre ; l'écriture n'est passée qu'à
  l'approbation, dans la même transaction que la décision, sa trace au journal d'audit et
  l'avis au titulaire. Demander et approuver sont deux permissions (`adjustments.request`,
  `adjustments.approve`), que seul `super_admin` détient.
- **La règle des quatre yeux est imposée par la base de données**, quel que soit le code qui
  écrit : l'approbation et le refus viennent d'un autre que l'auteur de la demande ; nul ne
  prend part à un ajustement de son propre portefeuille ; les deux intervenants sont actifs
  et habilités **au moment de l'approbation** — une demande déposée par un compte suspendu
  depuis ne s'approuve plus ; une demande se décide une seule fois, ses termes ne changent
  jamais, et elle échoit après 72 heures, à l'horloge de la base.
- **Un ajustement approuvé et son écriture vont ensemble**, vérifié à la validation de la
  transaction : l'écriture désignée est celle de l'ajustement — son type, ses deux lignes,
  son montant, le portefeuille du titulaire et le compte de conservation —, et toute écriture
  de ce type a son ajustement approuvé. Aucune écriture **d'ajustement** n'échappe donc à la
  double validation, même écrite en SQL sous le rôle de l'API — et une écriture d'un autre
  type que ceux des opérations est refusée (voir « Grand livre »). Le propriétaire du schéma
  lui-même ne passe pas un ajustement sans deux personnes habilitées, tant que les règles
  sont en place.
- **Preuve de l'approbateur.** Une session ouverte ne suffit pas à déplacer des fonds :
  l'approbation exige de nouveau le mot de passe et le second facteur de l'approbateur,
  vérifiés avant tout examen de la demande ; les essais erronés sont bornés et tracés.
- **Une demande identique ne s'approuve pas deux fois par mégarde** : une seule demande —
  même portefeuille, même sens, même montant — peut être en attente.
- **Fermé par défaut.** Demander et approuver exigent que la fonctionnalité
  `manualAdjustments` soit ouverte ; la refermer arrête l'un et l'autre en moins de cinq
  secondes, sans empêcher de refuser ni de retirer ce qui est en attente.
- **Le titulaire est prévenu** de tout crédit et de tout débit passé par la plateforme : un
  e-mail, le mouvement dans son portefeuille, l'événement dans l'historique de son compte.
  **La justification ne lui est jamais montrée** — ni par l'API, ni par le message, ni dans la
  copie de ses données. Elle ne figure pas non plus dans le grand livre, dont l'écriture ne
  porte que des identifiants.
- **Geler un portefeuille arrête tout mouvement sur lui**, dans un actif : ni envoi, ni
  réception. La règle est posée **sur le grand livre lui-même**, à chaque ligne d'écriture :
  elle vaut d'office pour toute opération, y compris celles qui restent à écrire. Seules
  passent les écritures d'ajustement — qui exigent deux personnes : c'est par elles que des
  fonds quittent un portefeuille gelé.
- **Le gel est exact.** Il prend les verrous du titulaire et de son portefeuille : une
  écriture en cours s'achève avant lui, toute écriture qui le suit le voit. Aucun mouvement
  n'est validé sur un portefeuille après que son gel l'a été.
- **Geler et lever sont deux pouvoirs.** La conformité gèle (`wallet_freezes.create`) ; lever
  un gel (`wallet_freezes.lift`) est réservé à `super_admin`. Nul ne gèle son propre
  portefeuille, ni n'en lève le gel. La base relit ces droits au moment d'écrire.
- **Le titulaire sait que son portefeuille est gelé, jamais pourquoi** : le portefeuille le
  dit (`frozen`), un transfert tenté répond `WALLET_FROZEN`, le gel et sa levée figurent dans
  son historique. Aucun message ne lui est envoyé. Qui lui envoie des fonds reçoit le refus
  unique du destinataire : rien ne lui apprend que le portefeuille est gelé.
- **Un compte au portefeuille gelé ne se clôt pas** — ni par son titulaire, ni par le
  personnel : la clôture effacerait ce qui l'identifie.
- **Rien ne s'efface** : ni une demande d'ajustement, décidée ou non, ni un gel, levé ou
  non. Chaque demande, chaque décision, chaque approbation refusée, chaque gel, chaque levée
  et chaque consultation sont inscrits au journal d'audit — comme la tentative d'agir sur son
  propre portefeuille.

> **Limites à connaître.**
>
> - **Un ajustement crée ce que deux personnes déclarent.** Un crédit approuvé met des fonds
>   à la disposition d'un titulaire sans que rien ne les rapproche d'un relevé bancaire ou
>   d'une adresse : la double validation est le seul contrôle. Deux personnes habilitées qui
>   s'entendent — ou deux comptes d'administration compromis — créditent n'importe quel
>   portefeuille, du montant qu'elles veulent : **aucun plafond ne borne un ajustement**.
> - **Un accès en écriture sous le rôle de l'API ne passe plus d'écriture libre, mais peut
>   encore écrire l'opération entière.** La base refuse désormais une écriture d'un type
>   qu'elle ne connaît pas (ADR 0030) : le chemin constaté sur la base d'aperçu — un
>   portefeuille crédité depuis le compte de conservation par une écriture d'un type
>   inventé — est fermé. Reste la limite qui suit.
> - **La base vérifie la qualité des deux intervenants, pas leur présence** : c'est l'API qui
>   les lui désigne. Un attaquant capable d'exécuter du SQL sous le rôle de l'API pourrait
>   fabriquer une demande et son approbation au nom de deux administrateurs existants — et
>   laisserait une demande ineffaçable qu'ils n'ont jamais faite (même limite que pour les
>   rôles, ADR 0018). La preuve redemandée à l'approbateur est vérifiée par l'API, non par la
>   base.
> - **Aucun niveau de vérification n'est exigé du titulaire crédité** : c'est aux deux
>   personnes d'en juger. Les plafonds de transfert, eux, s'appliquent ensuite à ce qu'il
>   envoie.
> - **Lever un gel est l'acte d'une seule personne**, comme le poser : une justification, pas
>   de double validation.
> - **Un gel se voit.** Le titulaire l'apprend à sa prochaine lecture de ses portefeuilles :
>   il n'existe pas de gel « silencieux ». Pour une mesure qui ne doit pas alerter son objet,
>   ce n'est pas l'outil.
> - **Un gel vaut pour un actif.** Geler tous les portefeuilles d'un compte, c'est les geler
>   un à un — ou suspendre le compte, qui n'envoie ni ne reçoit plus rien.
> - **Le support ne voit pas les gels** : il ne peut pas dire à un titulaire pourquoi ses
>   transferts sont refusés, seulement le renvoyer vers qui le peut.
> - **La justification d'une demande ou d'un gel est un texte libre**, conservé indéfiniment :
>   ce qu'on y écrit sur une personne y reste. Elle n'est lue que par qui détient la
>   permission de consulter, et chaque consultation est tracée.
> - **Les messages informent, ils ne garantissent rien** : sans serveur d'e-mail configuré,
>   le titulaire n'est pas prévenu d'un ajustement, qui a lieu quand même.

### Conservation et purge

- Une tâche horaire supprime : les inscriptions jamais vérifiées (7 jours), les sessions
  terminées (90 jours après leur échéance — la plus récente de chaque compte est conservée),
  les codes expirés (7 jours), les enrôlements de second facteur abandonnés (24 heures), les
  dossiers de vérification jamais déposés (30 jours, avec leurs pièces), les événements
  publiés de la boîte d'envoi (30 jours), et clôt les demandes de rôle et les demandes
  d'ajustement échues. Chaque
  suppression d'inscription ou de dossier est tracée. Une inscription supprimée emporte
  l'acceptation des conditions qu'elle portait.
- **Comptes clôturés** : à l'échéance (trente jours après la clôture, ou dix ans si des
  dossiers de vérification sont conservés ou si une écriture a été passée sur un de leurs
  comptes du grand livre), la même tâche efface les dossiers conservés et
  leurs pièces, puis l'adresse et le numéro que gardait la trace de la clôture — 200 comptes
  au plus par passage ; chaque effacement est tracé. Un compte qui ne peut pas être effacé est
  signalé et retenté à chaque passage, sans bloquer les autres.
- **Un dossier de vérification déposé n'est effacé que par ces deux voies** : à la clôture
  s'il n'a jamais été examiné, à l'échéance légale sinon. Tant que le compte est ouvert, il
  est conservé.
- **Le journal d'audit n'est jamais purgé**, le grand livre non plus.

### Base de données

- Séparation des rôles : l'API se connecte avec un rôle sans aucun droit sur le schéma, ni
  aucun accès à l'historique des migrations.
- Requêtes paramétrées exclusivement (client Prisma, gabarits `Prisma.sql`) : aucune
  concaténation de SQL avec une entrée utilisateur.
- Délai maximal d'exécution par requête ; taille du pool bornée.

### Fonctionnalités réglementées

- Toute fonctionnalité (inscription, KYC, dépôts, retraits, échange, P2P, transferts) est
  **désactivée par défaut**. L'ouvrir exige une modification de paramètre, tracée dans le
  journal d'audit avec son auteur et sa justification.
- Ouvrir les transferts ne suffit pas à en permettre : il faut encore des plafonds, niveau
  par niveau et actif par actif — et aucun n'existe par défaut. Refermer la fonctionnalité
  arrête les envois en moins de cinq secondes — le temps que chaque instance de l'API relise
  ses paramètres ; les transferts passés restent consultables.
- Les **ajustements manuels** sont une fonctionnalité comme les autres : fermés par défaut,
  ouverts par une décision tracée. C'est la seule route de l'API par laquelle des fonds
  entrent dans le grand livre : tant qu'elle n'a jamais été ouverte, aucune route n'a crédité
  un portefeuille. Geler un portefeuille, en revanche, ne dépend d'aucune ouverture.
- Fermer la vérification d'identité aux titulaires ne ferme pas son examen : la conformité
  peut toujours vider la file et retirer une vérification, y compris pendant la maintenance.
- Une valeur de paramètre corrompue en base est ignorée au profit de l'état fermé.
- La disponibilité technique d'une fonctionnalité ne vaut pas autorisation légale : les
  exigences réglementaires de chaque pays doivent être établies avant toute ouverture.

### Chaîne d'approvisionnement

- Versions exactes épinglées (catalogue pnpm) et fichier de verrouillage figé en CI.
- Une version publiée depuis moins de 3 jours n'est jamais installée.
- Scripts d'installation des dépendances refusés par défaut ; liste d'autorisation explicite
  et commentée dans `pnpm-workspace.yaml`.
- `pnpm audit` en CI ; actions GitHub épinglées par empreinte de commit ; permissions
  minimales du jeton de CI.

### Conteneurs

- Images d'exécution et de migration : utilisateur non privilégié ; l'image d'exécution ne
  contient que le code compilé et les dépendances de production.
- Compose : système de fichiers en lecture seule, toutes les capacités retirées,
  `no-new-privileges` ; PostgreSQL et Redis ne sont publiés que sur l'interface locale. Le
  seul emplacement inscriptible de l'API est le volume des pièces de vérification.

### Garde-fous dans le code

- ESLint interdit `parseFloat` et `toFixed` : aucun montant ne passe par un nombre flottant.
- Aucun module n'écrit un solde : il passe une écriture par `LedgerService`, seul chemin
  vers les tables du grand livre. Le module des transferts ne fait pas exception.
- Les frontières d'architecture sont vérifiées statiquement.

## Prévu — non réalisé à ce jour

| Sujet                                                                                      | Phase |
| ------------------------------------------------------------------------------------------ | ----- |
| Procédure du support pour le retrait d'un second facteur (vérification d'identité)         | 2     |
| Rotation des clés de chiffrement — secrets de connexion, pièces de vérification            | 2     |
| Clés d'accès (WebAuthn / passkeys) comme second facteur résistant à l'hameçonnage          | 2+    |
| Vérification des mots de passe contre les fuites connues                                   | 2     |
| E-mails : exploitation des non-remises et des plaintes, plafond global d'envoi             | 2     |
| Conditions d'utilisation : texte et règle (propriétaire, conseil juridique)                | —     |
| Conditions d'utilisation : annonce d'une version par e-mail, préavis, double validation    | 2+    |
| Données personnelles : validation juridique des durées, formalités auprès de l'autorité    | 8     |
| Remise au titulaire des fichiers de ses pièces ; double validation d'une clôture           | 2+    |
| Durée de conservation du journal d'audit, des sauvegardes et des journaux applicatifs      | 8–9   |
| KYC : analyse antivirus des pièces, contrôle automatique des pièces et du visage           | 2+    |
| KYC : filtrage (sanctions, personnes politiquement exposées), relance des pièces expirées  | 8     |
| KYC : vérification des entreprises (KYB)                                                   | 2     |
| Plafonds de transfert : valeurs (propriétaire, conformité)                                 | —     |
| Plafonds : double validation d'un changement, bornes en réception et tous actifs confondus | 3+    |
| Transferts : délai de rétractation, bénéficiaires enregistrés, second facteur obligatoire  | 3+    |
| Fonds réservés (avec la première opération en plusieurs temps)                             | 3     |
| Ajustements : plafond par ajustement, rapprochement avec une pièce (relevé, reçu)          | 3+    |
| Gel : double validation de la levée, gel de tout un compte, visibilité pour le support     | 3+    |
| Grand livre : rapprochement avec les fonds réellement détenus, alerte sur une anomalie     | 3–9   |
| Grand livre : double validation de l'enregistrement d'un actif                             | 3     |
| Stockage objet des pièces (aujourd'hui : un volume), sauvegarde outillée de la clé         | 9     |
| Consultation du journal d'audit depuis le back-office ; alertes sur les actions sensibles  | 2+    |
| Protection CSRF du client web (les jetons y seront portés par un cookie `HttpOnly`)        | 7     |
| Dépôts et retraits — chacun sous clé d'idempotence, comme le transfert                     | 4     |
| Webhooks signés, protection contre le rejeu                                                | 4     |
| Gestion des clés blockchain hors de l'application (HSM / KMS), politiques de signature     | 5     |
| Surveillance des transactions, plafonds, filtrage, dossiers de conformité                  | 8     |
| TLS de bout en bout, sauvegardes chiffrées, restauration testée, alertes                   | 9     |
| Analyse de vulnérabilités des images, tests d'intrusion                                    | 9     |

## Signaler une vulnérabilité

Ne pas ouvrir de ticket public. Le canal de signalement sera publié avant toute mise en
service ; d'ici là, contacter directement le propriétaire du dépôt.
