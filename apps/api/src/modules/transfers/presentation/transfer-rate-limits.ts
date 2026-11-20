import type { RateLimitPolicy } from '../../../infrastructure/rate-limit/rate-limit.decorators.js';

/**
 * Création d'un transfert, par adresse IP. Volontairement large — derrière un opérateur
 * mobile, de nombreux clients partagent une adresse : la protection fine se fait par compte
 * (essais de mot de passe, transferts par heure, destinataires refusés). Chaque essai vérifie
 * un mot de passe, ce qui coûte du calcul : la borne protège le serveur.
 */
export const TRANSFER_RATE_LIMIT: RateLimitPolicy = {
  name: 'transfers-creation',
  limit: 60,
  windowMs: 60_000,
};
