# Sécurité

Ce document distingue strictement ce qui est **en place et testé** de ce qui est **prévu**.
Rien de ce qui figure dans la seconde catégorie ne doit être considéré comme acquis.

## En place (phases 1 et 2, lots 1 à 5)

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

### Conservation et purge

- Une tâche horaire supprime : les inscriptions jamais vérifiées (7 jours), les sessions
  terminées (90 jours après leur échéance — la plus récente de chaque compte est conservée),
  les codes expirés (7 jours), les enrôlements de second facteur abandonnés (24 heures), les
  dossiers de vérification jamais déposés (30 jours, avec leurs pièces), les événements
  publiés de la boîte d'envoi (30 jours), et clôt les demandes de rôle échues. Chaque
  suppression d'inscription ou de dossier est tracée. Une inscription supprimée emporte
  l'acceptation des conditions qu'elle portait.
- **Comptes clôturés** : à l'échéance (trente jours après la clôture, ou dix ans si des
  dossiers de vérification sont conservés), la même tâche efface les dossiers conservés et
  leurs pièces, puis l'adresse et le numéro que gardait la trace de la clôture — 200 comptes
  au plus par passage ; chaque effacement est tracé. Un compte qui ne peut pas être effacé est
  signalé et retenté à chaque passage, sans bloquer les autres.
- **Un dossier de vérification déposé n'est effacé que par ces deux voies** : à la clôture
  s'il n'a jamais été examiné, à l'échéance légale sinon. Tant que le compte est ouvert, il
  est conservé.
- **Le journal d'audit n'est jamais purgé.**

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
- Les frontières d'architecture sont vérifiées statiquement.

## Prévu — non réalisé à ce jour

| Sujet                                                                                     | Phase |
| ----------------------------------------------------------------------------------------- | ----- |
| Procédure du support pour le retrait d'un second facteur (vérification d'identité)        | 2     |
| Rotation des clés de chiffrement — secrets de connexion, pièces de vérification           | 2     |
| Clés d'accès (WebAuthn / passkeys) comme second facteur résistant à l'hameçonnage         | 2+    |
| Vérification des mots de passe contre les fuites connues                                  | 2     |
| E-mails : exploitation des non-remises et des plaintes, plafond global d'envoi            | 2     |
| Conditions d'utilisation : texte et règle (propriétaire, conseil juridique)               | —     |
| Conditions d'utilisation : annonce d'une version par e-mail, préavis, double validation   | 2+    |
| Données personnelles : validation juridique des durées, formalités auprès de l'autorité   | 8     |
| Remise au titulaire des fichiers de ses pièces ; double validation d'une clôture          | 2+    |
| Durée de conservation du journal d'audit, des sauvegardes et des journaux applicatifs     | 8–9   |
| KYC : analyse antivirus des pièces, contrôle automatique des pièces et du visage          | 2+    |
| KYC : filtrage (sanctions, personnes politiquement exposées), relance des pièces expirées | 8     |
| KYC : vérification des entreprises (KYB), plafonds par niveau                             | 2–3   |
| Stockage objet des pièces (aujourd'hui : un volume), sauvegarde outillée de la clé        | 9     |
| Consultation du journal d'audit depuis le back-office ; alertes sur les actions sensibles | 2+    |
| Protection CSRF du client web (les jetons y seront portés par un cookie `HttpOnly`)       | 7     |
| Idempotence des opérations financières, contrôle de concurrence du grand livre            | 3     |
| Webhooks signés, protection contre le rejeu                                               | 4     |
| Gestion des clés blockchain hors de l'application (HSM / KMS), politiques de signature    | 5     |
| Surveillance des transactions, plafonds, filtrage, dossiers de conformité                 | 8     |
| TLS de bout en bout, sauvegardes chiffrées, restauration testée, alertes                  | 9     |
| Analyse de vulnérabilités des images, tests d'intrusion                                   | 9     |

## Signaler une vulnérabilité

Ne pas ouvrir de ticket public. Le canal de signalement sera publié avant toute mise en
service ; d'ici là, contacter directement le propriétaire du dépôt.
