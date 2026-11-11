# 0014 — Mots de passe : Argon2id natif, règles NIST

**Statut :** acceptée (2026-11-11)

## Décision

- **Argon2id** (RFC 9106) par l'implémentation native de Node.js 24 (`crypto.argon2`) :
  aucune dépendance, aucun module compilé à l'installation.
- Coût par défaut : 19 Mio de mémoire, 2 passes, parallélisme 1 (minimum recommandé par
  l'OWASP). La configuration **refuse un coût inférieur** en pré-production et en production ;
  les tests utilisent un coût réduit.
- Empreinte au format PHC (elle porte ses paramètres) : renforcer le coût ne demande aucune
  migration, l'empreinte est recalculée à la connexion suivante.
- Table `user_credentials` séparée de `users` ; une contrainte n'y accepte qu'une empreinte Argon2id.
- Règles de choix (NIST SP 800-63B) : 10 à 128 caractères, normalisation Unicode NFKC, aucune
  règle de composition ni renouvellement périodique ; refus des mots de passe trop courants,
  trop répétitifs ou dérivés de l'adresse ou du téléphone.

## Conséquences

- Le hachage s'exécute sur le groupe de fils de Node.js : au plus quatre calculs simultanés
  par instance. Combiné aux limites de débit, cela borne le coût d'une attaque par saturation,
  mais une protection en amont (pare-feu applicatif) restera nécessaire à grande échelle.
- La liste des mots de passe courants est courte et embarquée ; la vérification contre les
  fuites connues (k-anonymat) est à ajouter.
- Pas de « poivre » serveur sur les mots de passe : il imposerait une gestion de clé
  supplémentaire pour un gain limité avec Argon2id. À réévaluer avec le coffre de secrets.
