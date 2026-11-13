import { createHmac, randomInt } from 'node:crypto';

import { RECOVERY_CODE_COUNT } from '@mgx/contracts';
import { RECOVERY_CODE_ALPHABET, RECOVERY_CODE_LENGTH } from '@mgx/validation';
import { Injectable } from '@nestjs/common';

import { AppConfig } from '../../../config/app-config.js';
import type { Digest } from '../application/digest.js';

/**
 * Codes de secours du second facteur : dix codes de dix caractères (50 bits d'aléa chacun),
 * à usage unique, remis une seule fois à l'utilisateur.
 *
 * Seule leur empreinte est conservée, calculée par HMAC avec une clé absente de la base :
 * lire la base ne permet ni de les lire, ni de les retrouver par essais. Le compte entre dans
 * le calcul, de sorte qu'une empreinte ne vaut que pour lui.
 */
@Injectable()
export class RecoveryCodes {
  private readonly key: string;

  constructor(config: AppConfig) {
    this.key = config.auth.codeHmacSecret;
  }

  /** Codes sous leur forme canonique (sans tiret). */
  generate(count: number = RECOVERY_CODE_COUNT): string[] {
    return Array.from({ length: count }, () =>
      Array.from({ length: RECOVERY_CODE_LENGTH }, () =>
        RECOVERY_CODE_ALPHABET.charAt(randomInt(RECOVERY_CODE_ALPHABET.length)),
      ).join(''),
    );
  }

  /** Forme présentée à l'utilisateur : `ABCDE-12345`. */
  format(code: string): string {
    const half = RECOVERY_CODE_LENGTH / 2;
    return `${code.slice(0, half)}-${code.slice(half)}`;
  }

  /** @param code code sous sa forme canonique. */
  hash(userId: string, code: string): Digest {
    return new Uint8Array(
      createHmac('sha256', this.key).update(`recovery-code:${userId}:${code}`, 'utf8').digest(),
    );
  }
}
