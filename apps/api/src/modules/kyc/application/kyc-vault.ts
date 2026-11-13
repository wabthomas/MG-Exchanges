import { createHash, timingSafeEqual } from 'node:crypto';

import type { KycDocumentKind, KycIdentityDocumentType } from '@mgx/contracts';

import { AppError } from '../../../common/errors/app-error.js';
import type { KycCipher } from '../infrastructure/kyc-cipher.js';
import type { DocumentStorage } from './document-storage.js';

type Bytes = Uint8Array<ArrayBuffer>;

/** Ce qui identifie une pièce : son contenu chiffré ne se déchiffre que dans ce contexte. */
export interface DocumentIdentity {
  readonly id: string;
  readonly caseId: string;
  readonly kind: KycDocumentKind;
}

export interface StoredDocument {
  readonly storageKey: string;
  readonly wrappedKey: Bytes;
  readonly sha256: Bytes;
}

/** Le fichier d'une pièce est introuvable, illisible ou ne correspond plus à son empreinte. */
export class DocumentUnreadableError extends Error {
  constructor(reason: 'MISSING' | 'UNDECRYPTABLE' | 'CORRUPTED', options?: ErrorOptions) {
    super(`Verification document cannot be read: ${reason}.`, options);
    this.name = 'DocumentUnreadableError';
  }
}

function unavailable(): AppError {
  return new AppError(
    'SERVICE_UNAVAILABLE',
    'Identity verification is not available: document storage is not configured.',
  );
}

function documentContext({ id, caseId, kind }: DocumentIdentity): string {
  return `kyc:document:${id}:case:${caseId}:kind:${kind}`;
}

function documentNumberContext(userId: string): string {
  return `kyc:identity-document-number:user:${userId}`;
}

/** Emplacement d'une pièce : répartie dans 256 répertoires d'après la fin de son identifiant. */
function storageKeyOf(documentId: string): string {
  return `${documentId.slice(-2)}/${documentId}`;
}

/**
 * Coffre des données sensibles de la vérification d'identité : pièces (chiffrées, hors de la
 * base) et numéros de pièce d'identité (chiffrés, en base).
 *
 * Sans stockage ni clé configurés (`KYC_STORAGE_DIR`, `KYC_ENCRYPTION_KEY`), le coffre est
 * **indisponible** : toute opération répond `SERVICE_UNAVAILABLE`, et rien n'est jamais écrit
 * en clair.
 */
export class KycVault {
  constructor(
    private readonly backend: {
      readonly cipher: KycCipher;
      readonly storage: DocumentStorage;
    } | null,
  ) {}

  get available(): boolean {
    return this.backend !== null;
  }

  /** @throws AppError `SERVICE_UNAVAILABLE` si le coffre n'est pas configuré. */
  assertAvailable(): void {
    if (this.backend === null) {
      throw unavailable();
    }
  }

  /** Au démarrage : vérifie que le stockage des pièces est utilisable, s'il est configuré. */
  async prepare(): Promise<void> {
    await this.backend?.storage.prepare();
  }

  /** Chiffre la pièce et l'écrit dans le stockage. */
  async storeDocument(identity: DocumentIdentity, content: Uint8Array): Promise<StoredDocument> {
    const { cipher, storage } = this.open();
    const sealed = cipher.sealDocument(content, documentContext(identity));
    const storageKey = storageKeyOf(identity.id);
    await storage.put(storageKey, sealed.ciphertext);
    return {
      storageKey,
      wrappedKey: sealed.wrappedKey,
      sha256: new Uint8Array(createHash('sha256').update(content).digest()),
    };
  }

  /**
   * Relit une pièce en clair, après avoir vérifié qu'elle est bien celle qui a été reçue.
   *
   * @throws DocumentUnreadableError si le fichier manque, ne se déchiffre pas ou a changé.
   */
  async loadDocument(identity: DocumentIdentity, stored: StoredDocument): Promise<Buffer> {
    const { cipher, storage } = this.open();
    const ciphertext = await storage.get(stored.storageKey);
    if (ciphertext === null) {
      throw new DocumentUnreadableError('MISSING');
    }
    let content: Buffer;
    try {
      content = cipher.openDocument(
        { ciphertext, wrappedKey: stored.wrappedKey },
        documentContext(identity),
      );
    } catch (error) {
      throw new DocumentUnreadableError('UNDECRYPTABLE', { cause: error });
    }
    const digest = createHash('sha256').update(content).digest();
    if (digest.length !== stored.sha256.length || !timingSafeEqual(digest, stored.sha256)) {
      throw new DocumentUnreadableError('CORRUPTED');
    }
    return content;
  }

  /** Efface le fichier d'une pièce. Sans effet s'il a déjà disparu. */
  async removeDocument(storageKey: string): Promise<void> {
    await this.open().storage.delete(storageKey);
  }

  encryptDocumentNumber(userId: string, number: string): Bytes {
    return this.open().cipher.encryptField(number, documentNumberContext(userId));
  }

  decryptDocumentNumber(userId: string, encrypted: Uint8Array): string {
    return this.open().cipher.decryptField(encrypted, documentNumberContext(userId));
  }

  /**
   * Empreinte d'une pièce d'identité — nature, pays de délivrance et numéro : la même pièce
   * donne la même empreinte, quel que soit le compte qui la présente.
   */
  documentNumberDigest(
    type: KycIdentityDocumentType,
    issuingCountry: string,
    number: string,
  ): Bytes {
    return this.open().cipher.lookupDigest(['identity-document', type, issuingCountry, number]);
  }

  private open(): { readonly cipher: KycCipher; readonly storage: DocumentStorage } {
    if (this.backend === null) {
      throw unavailable();
    }
    return this.backend;
  }
}
