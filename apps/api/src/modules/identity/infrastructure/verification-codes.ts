import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { VERIFICATION_CODE_LENGTH } from '@mgx/validation';
import { Injectable } from '@nestjs/common';

import { AppConfig } from '../../../config/app-config.js';
import type { Digest } from '../application/digest.js';

/**
 * Codes à usage unique envoyés à l'utilisateur (six chiffres).
 *
 * Un code est court : son empreinte simple se retrouverait par essais en un instant. Elle est
 * donc calculée par HMAC avec une clé qui n'est pas dans la base : la lecture de la base ne
 * suffit pas à retrouver un code. L'identifiant du défi entre dans le calcul, de sorte qu'une
 * empreinte ne vaut que pour son défi.
 */
@Injectable()
export class VerificationCodes {
  private readonly key: string;

  constructor(config: AppConfig) {
    this.key = config.auth.codeHmacSecret;
  }

  generate(): string {
    return randomInt(0, 10 ** VERIFICATION_CODE_LENGTH)
      .toString()
      .padStart(VERIFICATION_CODE_LENGTH, '0');
  }

  hash(challengeId: string, code: string): Digest {
    return new Uint8Array(
      createHmac('sha256', this.key).update(`${challengeId}:${code}`, 'utf8').digest(),
    );
  }

  /** Comparaison à temps constant du code présenté avec l'empreinte attendue. */
  matches(expectedHash: Uint8Array, challengeId: string, code: string): boolean {
    const actual = this.hash(challengeId, code);
    return expectedHash.length === actual.length && timingSafeEqual(expectedHash, actual);
  }
}
