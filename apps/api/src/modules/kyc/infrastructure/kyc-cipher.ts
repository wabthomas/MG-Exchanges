import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES;

type Bytes = Uint8Array<ArrayBuffer>;

/** Le contenu chiffré est illisible : mauvaise clé, donnée altérée ou déplacée. */
export class KycDecryptionError extends Error {
  constructor() {
    super('Encrypted verification data cannot be decrypted.');
    this.name = 'KycDecryptionError';
  }
}

/** Fichier chiffré, et la clé qui le déchiffre — elle-même chiffrée par la clé maîtresse. */
export interface SealedDocument {
  readonly ciphertext: Bytes;
  readonly wrappedKey: Bytes;
}

function seal(key: Uint8Array, plaintext: Uint8Array, context: string): Buffer<ArrayBuffer> {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = cipher.update(plaintext);
  const last = cipher.final();
  return Buffer.concat([
    Buffer.from([FORMAT_VERSION]),
    nonce,
    ciphertext,
    last,
    cipher.getAuthTag(),
  ]);
}

/**
 * Copie autonome d'une petite valeur destinée à la base : un `Buffer` de petite taille est
 * une vue sur une réserve partagée, que l'on ne confie pas à un pilote de base de données.
 */
function detached(bytes: Uint8Array): Bytes {
  return new Uint8Array(bytes);
}

function open(key: Uint8Array, envelope: Uint8Array, context: string): Buffer {
  const bytes = Buffer.from(envelope);
  if (bytes.length < HEADER_BYTES + TAG_BYTES || bytes.readUInt8(0) !== FORMAT_VERSION) {
    throw new KycDecryptionError();
  }
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, HEADER_BYTES));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(bytes.subarray(HEADER_BYTES, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new KycDecryptionError();
  }
}

/**
 * Chiffrement des données de vérification d'identité (AES-256-GCM), sous une clé maîtresse
 * tenue hors de la base et hors du stockage des pièces (`KYC_ENCRYPTION_KEY`).
 *
 *  - **Pièces** : chaque fichier est chiffré avec une clé qui lui est propre, tirée au hasard ;
 *    cette clé, chiffrée par la clé maîtresse, est conservée en base avec la description de la
 *    pièce. Le fichier seul est indéchiffrable ; effacer la ligne le rend définitivement
 *    illisible, même si le fichier subsiste.
 *  - **Numéros de pièce** : chiffrés en base ; une empreinte à clé permet de retrouver une même
 *    pièce présentée sur plusieurs comptes sans rien déchiffrer.
 *
 * Trois sous-clés indépendantes sont dérivées de la clé maîtresse (HKDF-SHA-256), une par
 * usage. Le **contexte** (à quel dossier, à quelle pièce appartient la donnée) est authentifié
 * avec elle : un contenu recopié sur une autre ligne ne se déchiffre pas.
 *
 * Format : version (1 octet) ‖ nonce (12) ‖ chiffré ‖ étiquette d'authenticité (16).
 */
export class KycCipher {
  private readonly wrappingKey: Buffer;
  private readonly fieldKey: Buffer;
  private readonly lookupKey: Buffer;

  constructor(masterKeyBase64: string) {
    const master = Buffer.from(masterKeyBase64, 'base64');
    if (master.length !== KEY_BYTES) {
      throw new Error('The KYC encryption key must be 32 bytes.');
    }
    const derive = (purpose: string): Buffer =>
      Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `mgx:kyc:${purpose}:v1`, KEY_BYTES));
    this.wrappingKey = derive('document-keys');
    this.fieldKey = derive('fields');
    this.lookupKey = derive('lookup');
  }

  sealDocument(content: Uint8Array, context: string): SealedDocument {
    const documentKey = randomBytes(KEY_BYTES);
    try {
      return {
        // Le fichier chiffré n'est pas recopié : une pièce peut peser plusieurs mégaoctets.
        ciphertext: seal(documentKey, content, context),
        wrappedKey: detached(seal(this.wrappingKey, documentKey, context)),
      };
    } finally {
      documentKey.fill(0);
    }
  }

  /** @throws KycDecryptionError si la pièce ne se déchiffre pas dans ce contexte. */
  openDocument(
    sealed: { readonly ciphertext: Uint8Array; readonly wrappedKey: Uint8Array },
    context: string,
  ): Buffer {
    const documentKey = open(this.wrappingKey, sealed.wrappedKey, context);
    try {
      if (documentKey.length !== KEY_BYTES) {
        throw new KycDecryptionError();
      }
      return open(documentKey, sealed.ciphertext, context);
    } finally {
      documentKey.fill(0);
    }
  }

  encryptField(value: string, context: string): Bytes {
    return detached(seal(this.fieldKey, Buffer.from(value, 'utf8'), context));
  }

  /** @throws KycDecryptionError si la valeur ne se déchiffre pas dans ce contexte. */
  decryptField(envelope: Uint8Array, context: string): string {
    return open(this.fieldKey, envelope, context).toString('utf8');
  }

  /**
   * Empreinte à clé (HMAC-SHA-256) d'une suite de valeurs : identique pour les mêmes valeurs,
   * inexploitable sans la clé. Chaque valeur est précédée de sa longueur, pour que deux suites
   * différentes ne se confondent jamais.
   */
  lookupDigest(parts: readonly string[]): Bytes {
    const hmac = createHmac('sha256', this.lookupKey);
    for (const part of parts) {
      const bytes = Buffer.from(part, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      hmac.update(length).update(bytes);
    }
    return new Uint8Array(hmac.digest());
  }
}
