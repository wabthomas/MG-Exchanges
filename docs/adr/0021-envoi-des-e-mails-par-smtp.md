# 0021 — Envoi des e-mails par SMTP

**Statut :** acceptée (2026-11-12)

## Contexte

Tant qu'aucun moyen d'envoi n'existait, l'inscription ne pouvait pas ouvrir hors développement
(ADR 0016) : sans code reçu, pas de compte. Le choix d'un prestataire d'e-mail reste une
décision commerciale — tarifs, délivrabilité vers les messageries utilisées en RDC, contrat —
qui n'est pas prise et ne doit pas bloquer le code.

## Décision

**L'API envoie ses e-mails par SMTP**, le seul protocole que tous les prestataires proposent
(Amazon SES, Brevo, Mailgun, Postmark, SendGrid…). Le prestataire se choisit au déploiement,
par configuration (`SMTP_HOST`, identifiants, `EMAIL_FROM`) ; en changer ne demande aucun
développement. L'adaptateur est une implémentation de plus du port `NotificationSender`
(bibliothèque `nodemailer`, sans dépendance).

- **Chiffrement exigé hors développement.** `starttls` (défaut) refuse de poursuivre si le
  serveur ne passe pas en TLS ; `tls` chiffre dès l'ouverture. Le certificat est toujours
  vérifié. `none` n'existe que pour un outil local de capture, et la configuration le refuse
  en pré-production et en production.
- **Un destinataire, et un seul.** La bibliothèque lit un destinataire comme une liste
  d'adresses ; l'adaptateur refuse donc tout ce qui n'est pas une adresse nue, sans se fier à
  la validation faite à l'inscription.
- **Rien de personnel dans les journaux.** Une ligne par message accepté (modèle, identifiant
  du message) ; jamais l'adresse ni le texte. Les réponses du serveur sont journalisées
  adresses masquées.
- **Échecs.** Une panne ou un refus temporaire fait échouer le traitement, que la file
  retente (cinq essais). Un refus **définitif du destinataire** (boîte inexistante) n'est pas
  retenté : insister ne changerait rien et nuirait à la réputation de l'expéditeur.
- **Vérification au démarrage**, en arrière-plan : serveur injoignable ou identifiants
  refusés apparaissent en erreur dans le journal dès le déploiement. L'API démarre quand même —
  une panne du prestataire ne doit pas l'empêcher de servir les utilisateurs déjà inscrits.
- **Les SMS ne sont pas concernés.** Ce canal reste indisponible (`503`) jusqu'au choix d'un
  prestataire SMS, dont l'API sera propre à ce prestataire.

## Conséquences

- L'inscription peut ouvrir en pré-production et en production dès qu'un compte d'envoi est
  configuré et que le domaine expéditeur est autorisé chez le prestataire (SPF, DKIM, DMARC).
- **Ce qui n'est pas traité** : les retours de non-remise et les plaintes signalés après coup
  par le prestataire (ils passent par ses API ou ses webhooks, propres à chacun) ; aucun
  plafond global d'envoi. À reprendre une fois le prestataire choisi.
- La remise est « au moins une fois » : en cas de reprise après incident, un même message
  peut partir deux fois. Pour un code, le dernier reçu fait foi (ADR 0016).
- Les messages sont en texte seul. Une mise en forme HTML viendra avec l'identité visuelle.
- Vérifié contre un serveur SMTP réel exécuté par les tests (chiffrement, authentification,
  refus, pannes), jamais contre le service d'un prestataire.
