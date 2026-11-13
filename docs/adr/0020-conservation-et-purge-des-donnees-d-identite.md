# 0020 — Conservation et purge des données d'identité

**Statut :** acceptée (2026-11-12) — durées à confirmer avec la conformité

## Contexte

Le lot 1 conservait tout : inscriptions jamais vérifiées, sessions terminées, codes expirés.
Certaines de ces données n'ont plus d'utilité, et une inscription jamais vérifiée contient
une adresse — peut-être celle d'un tiers — et un mot de passe qui n'ont pas à être gardés.

## Décision

Une tâche planifiée (BullMQ, toutes les heures, un seul planificateur pour toutes les
instances) applique ces règles :

| Donnée                                    | Suppression                                                |
| ----------------------------------------- | ---------------------------------------------------------- |
| inscription jamais vérifiée               | 7 jours après l'inscription (ou la dernière réinscription) |
| session terminée                          | 90 jours après son échéance d'inactivité                   |
| code à usage unique                       | 7 jours après son expiration                               |
| enrôlement de second facteur non confirmé | 24 heures                                                  |
| demande de changement de rôle échue       | conservée, passée à `EXPIRED`                              |

- **La dernière session de chaque compte est conservée** : elle atteste qu'il s'est déjà
  connecté, ce dont dépend l'avertissement « nouvel appareil ». Sans cela, un compte resté
  longtemps inactif ne serait plus prévenu d'une connexion inhabituelle.
- **Le journal d'audit n'est jamais purgé**, et chaque suppression d'inscription y laisse une
  entrée (sans l'adresse).
- Chaque étape est indépendante et bornée (500 lignes par exécution) ; une inscription qui
  ne peut pas être supprimée est signalée sans bloquer les autres.
- Une inscription est supprimée ligne par ligne, sous verrou : une vérification de l'adresse
  survenue au même instant l'emporte sur la purge.

## Conséquences

- Une personne qui tarde plus de 7 jours à vérifier son adresse doit se réinscrire.
- Un appareil dont la dernière session a été purgée sera de nouveau signalé comme inconnu :
  on avertit plutôt trop que pas assez.
- Les comptes clôturés, les profils et les événements publiés de la boîte d'envoi ne sont pas
  encore purgés ; l'effacement à la demande du titulaire et la durée légale de conservation
  restent à définir (conformité, phase 8).
