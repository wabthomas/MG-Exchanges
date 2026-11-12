import { createHash, randomBytes } from 'node:crypto';

import type { Digest } from '../application/digest.js';

export type SessionTokenKind = 'access' | 'refresh' | 'mfa';

/**
 * Préfixes reconnaissables : ils indiquent la nature d'un jeton trouvé dans un journal ou un
 * dépôt de code, et permettent aux outils de détection de secrets de le signaler.
 */
const PREFIXES: Readonly<Record<SessionTokenKind, string>> = {
  access: 'mgx_at_',
  refresh: 'mgx_rt_',
  /** Jeton d'une connexion en attente du second facteur : n'ouvre aucun droit par lui-même. */
  mfa: 'mgx_mfa_',
};

const SECRET_BYTES = 32;
/** 32 octets aléatoires encodés en base64url : 43 caractères. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface IssuedToken {
  /** Jeton remis au client. N'est conservé nulle part côté serveur. */
  readonly token: string;
  /** Empreinte SHA-256, seule valeur stockée. */
  readonly hash: Digest;
}

function sha256(value: string): Digest {
  return new Uint8Array(createHash('sha256').update(value, 'utf8').digest());
}

/**
 * Jeton de session opaque : 256 bits d'aléa, sans aucune information. Il ne vaut que par
 * son enregistrement en base — il ne peut donc être ni forgé, ni prolongé, et sa révocation
 * est immédiate. Une empreinte SHA-256 suffit pour un secret de cette entropie.
 */
export function issueSessionToken(kind: SessionTokenKind): IssuedToken {
  const token = `${PREFIXES[kind]}${randomBytes(SECRET_BYTES).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

/**
 * Empreinte d'un jeton présenté par un client, ou `null` s'il n'a pas la forme attendue
 * (aucune recherche en base n'est alors nécessaire).
 */
export function hashPresentedToken(kind: SessionTokenKind, token: string): Digest | null {
  const prefix = PREFIXES[kind];
  if (!token.startsWith(prefix) || !SECRET_PATTERN.test(token.slice(prefix.length))) {
    return null;
  }
  return sha256(token);
}
