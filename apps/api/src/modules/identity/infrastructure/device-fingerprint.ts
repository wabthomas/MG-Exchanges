import { createHash } from 'node:crypto';

import type { Digest } from '../application/digest.js';

function sha256(value: string): Digest {
  return new Uint8Array(createHash('sha256').update(value, 'utf8').digest());
}

/**
 * Empreinte servant à reconnaître un appareil déjà utilisé par un compte.
 *
 * Elle repose sur l'identifiant d'appareil fourni par l'application cliente (valeur aléatoire
 * conservée sur l'appareil). À défaut — client qui n'en envoie pas —, sur l'agent utilisateur :
 * repère plus faible, mais qui évite de signaler chaque connexion comme nouvelle. Sans l'un ni
 * l'autre, l'appareil est toujours considéré comme inconnu.
 */
export function deviceFingerprint(
  deviceId: string | undefined,
  userAgent: string | undefined,
): Digest | null {
  if (deviceId !== undefined) {
    return sha256(`device-id:${deviceId}`);
  }
  if (userAgent !== undefined && userAgent !== '') {
    return sha256(`user-agent:${userAgent}`);
  }
  return null;
}
