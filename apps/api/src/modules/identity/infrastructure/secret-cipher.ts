import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AppConfig } from '../../../config/app-config.js';
import type { Digest } from '../application/digest.js';

const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES;

/** Le contenu chiffré est illisible : mauvaise clé, donnée altérée ou déplacée. */
export class SecretDecryptionError extends Error {
  constructor() {
    super('Encrypted secret cannot be decrypted.');
    this.name = 'SecretDecryptionError';
  }
}

/**
 * Chiffrement des secrets que l'application doit pouvoir relire — le secret TOTP du second
 * facteur, qu'une empreinte ne permettrait pas de vérifier.
 *
 * AES-256-GCM, clé hors de la base (`AUTH_SECRETS_ENCRYPTION_KEY`) : la lecture de la base
 * seule ne livre aucun secret. Le **contexte** (à qui et à quoi sert le secret) est
 * authentifié avec lui : un contenu chiffré recopié sur une autre ligne ne se déchiffre pas.
 *
 * Format : version (1 octet) ‖ nonce (12) ‖ chiffré ‖ étiquette d'authenticité (16).
 */
@Injectable()
export class SecretCipher {
  private readonly key: Buffer;

  constructor(config: AppConfig) {
    this.key = Buffer.from(config.auth.secretsEncryptionKey, 'base64');
  }

  encrypt(plaintext: Uint8Array, context: string): Digest {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return new Uint8Array(
      Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, ciphertext, cipher.getAuthTag()]),
    );
  }

  /** @throws SecretDecryptionError si le contenu ne peut pas être déchiffré dans ce contexte. */
  decrypt(envelope: Uint8Array, context: string): Buffer {
    const bytes = Buffer.from(envelope);
    if (bytes.length < HEADER_BYTES + TAG_BYTES || bytes.readUInt8(0) !== FORMAT_VERSION) {
      throw new SecretDecryptionError();
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(1, HEADER_BYTES));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    try {
      return Buffer.concat([
        decipher.update(bytes.subarray(HEADER_BYTES, bytes.length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new SecretDecryptionError();
    }
  }
}
