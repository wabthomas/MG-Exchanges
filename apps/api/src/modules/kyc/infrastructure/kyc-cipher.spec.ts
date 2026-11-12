import { describe, expect, it } from '@jest/globals';

import { KycCipher, KycDecryptionError } from './kyc-cipher.js';

const key = (seed: string): string => Buffer.from(seed.padEnd(32, '.')).toString('base64');
const MASTER_KEY = key('unit-test-kyc-master-key');
const cipher = new KycCipher(MASTER_KEY);
const CONTEXT = 'kyc:document:0195f3a2:case:0195f3a3:kind:SELFIE';
const content = Buffer.from('%PDF-1.7 contenu d’une pièce d’identité, à ne jamais écrire en clair');

/** Copie dont un octet est modifié. */
function tampered(bytes: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

describe('KycCipher — pièces', () => {
  it('une pièce se relit à l’identique avec sa clé et son contexte', () => {
    const sealed = cipher.sealDocument(content, CONTEXT);
    expect(cipher.openDocument(sealed, CONTEXT).equals(content)).toBe(true);
  });

  it('le fichier chiffré ne contient rien de la pièce, et n’est jamais deux fois le même', () => {
    const first = cipher.sealDocument(content, CONTEXT);
    const second = cipher.sealDocument(content, CONTEXT);

    expect(Buffer.from(first.ciphertext).includes(content.subarray(0, 8))).toBe(false);
    expect(Buffer.from(first.ciphertext).includes('pièce')).toBe(false);
    // Clé et nonce propres à chaque fichier.
    expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false);
    expect(Buffer.from(first.wrappedKey).equals(Buffer.from(second.wrappedKey))).toBe(false);
    // Format : version (1) ‖ nonce (12) ‖ chiffré ‖ étiquette (16).
    expect(first.ciphertext).toHaveLength(1 + 12 + content.length + 16);
    expect(first.wrappedKey).toHaveLength(1 + 12 + 32 + 16);
    expect(first.ciphertext[0]).toBe(1);
  });

  it('la clé d’un fichier n’ouvre que ce fichier', () => {
    const first = cipher.sealDocument(content, CONTEXT);
    const second = cipher.sealDocument(content, CONTEXT);
    expect(() =>
      cipher.openDocument({ ciphertext: first.ciphertext, wrappedKey: second.wrappedKey }, CONTEXT),
    ).toThrow(KycDecryptionError);
  });

  it('une pièce recopiée sous un autre contexte ne se déchiffre pas', () => {
    const sealed = cipher.sealDocument(content, CONTEXT);
    for (const context of [
      'kyc:document:0195f3a2:case:0195f3a3:kind:IDENTITY_FRONT',
      'kyc:document:0195f3a2:case:ffffffff:kind:SELFIE',
      'kyc:document:ffffffff:case:0195f3a3:kind:SELFIE',
      '',
    ]) {
      expect(() => cipher.openDocument(sealed, context)).toThrow(KycDecryptionError);
    }
  });

  it('toute altération — du fichier comme de sa clé — est détectée', () => {
    const sealed = cipher.sealDocument(content, CONTEXT);
    const { ciphertext, wrappedKey } = sealed;

    for (const index of [0, 1, 13, ciphertext.length - 1]) {
      expect(() =>
        cipher.openDocument({ ciphertext: tampered(ciphertext, index), wrappedKey }, CONTEXT),
      ).toThrow(KycDecryptionError);
    }
    for (const index of [0, 1, 13, wrappedKey.length - 1]) {
      expect(() =>
        cipher.openDocument({ ciphertext, wrappedKey: tampered(wrappedKey, index) }, CONTEXT),
      ).toThrow(KycDecryptionError);
    }
    // Tronqué, vide, ou d'un format inconnu.
    for (const broken of [
      ciphertext.slice(0, ciphertext.length - 1),
      ciphertext.slice(0, 20),
      new Uint8Array(0),
    ]) {
      expect(() => cipher.openDocument({ ciphertext: broken, wrappedKey }, CONTEXT)).toThrow(
        KycDecryptionError,
      );
    }
    expect(cipher.openDocument(sealed, CONTEXT).equals(content)).toBe(true);
  });

  it('une autre clé maîtresse n’ouvre rien', () => {
    const sealed = cipher.sealDocument(content, CONTEXT);
    const other = new KycCipher(key('another-master-key'));
    expect(() => other.openDocument(sealed, CONTEXT)).toThrow(KycDecryptionError);
  });

  it('un fichier vide se chiffre et se relit', () => {
    const sealed = cipher.sealDocument(new Uint8Array(0), CONTEXT);
    expect(cipher.openDocument(sealed, CONTEXT)).toHaveLength(0);
  });

  it('l’erreur de déchiffrement ne dit rien du contenu ni de la clé', () => {
    const sealed = cipher.sealDocument(content, CONTEXT);
    try {
      cipher.openDocument(sealed, 'autre contexte');
      throw new Error('Decryption should have failed.');
    } catch (error) {
      expect(error).toBeInstanceOf(KycDecryptionError);
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      expect(text).not.toContain(MASTER_KEY);
      expect(text).not.toContain('PDF');
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('KycCipher — numéros de pièce', () => {
  const USER_CONTEXT = 'kyc:identity-document-number:user:0195f3a2';

  it('un numéro se relit à l’identique, et son chiffré n’est jamais deux fois le même', () => {
    const first = cipher.encryptField('OP1234567', USER_CONTEXT);
    const second = cipher.encryptField('OP1234567', USER_CONTEXT);

    expect(cipher.decryptField(first, USER_CONTEXT)).toBe('OP1234567');
    expect(cipher.decryptField(second, USER_CONTEXT)).toBe('OP1234567');
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
    expect(Buffer.from(first).includes('OP1234567')).toBe(false);
    expect(first).toHaveLength(1 + 12 + 9 + 16);
  });

  it('le numéro d’un compte ne se déchiffre pas sur la ligne d’un autre', () => {
    const encrypted = cipher.encryptField('OP1234567', USER_CONTEXT);
    expect(() =>
      cipher.decryptField(encrypted, 'kyc:identity-document-number:user:ffffffff'),
    ).toThrow(KycDecryptionError);
    expect(() => cipher.decryptField(tampered(encrypted, 14), USER_CONTEXT)).toThrow(
      KycDecryptionError,
    );
  });

  it('les caractères non ASCII survivent à l’aller-retour', () => {
    const value = 'Numéro n° 12 — Kinshasa/Gombe';
    expect(cipher.decryptField(cipher.encryptField(value, USER_CONTEXT), USER_CONTEXT)).toBe(value);
  });
});

describe('KycCipher — empreinte de recherche', () => {
  const parts = ['identity-document', 'PASSPORT', 'CD', 'OP1234567'];

  it('les mêmes valeurs donnent la même empreinte de 32 octets ; elle dépend de la clé', () => {
    const digest = cipher.lookupDigest(parts);
    expect(digest).toHaveLength(32);
    expect(Buffer.from(cipher.lookupDigest([...parts])).equals(Buffer.from(digest))).toBe(true);
    expect(
      Buffer.from(new KycCipher(MASTER_KEY).lookupDigest(parts)).equals(Buffer.from(digest)),
    ).toBe(true);
    expect(
      Buffer.from(new KycCipher(key('another-master-key')).lookupDigest(parts)).equals(
        Buffer.from(digest),
      ),
    ).toBe(false);
  });

  it('une valeur différente — nature, pays ou numéro — donne une autre empreinte', () => {
    const digest = Buffer.from(cipher.lookupDigest(parts)).toString('hex');
    for (const other of [
      ['identity-document', 'NATIONAL_ID_CARD', 'CD', 'OP1234567'],
      ['identity-document', 'PASSPORT', 'CG', 'OP1234567'],
      ['identity-document', 'PASSPORT', 'CD', 'OP1234568'],
      ['identity-document', 'PASSPORT', 'CD'],
    ]) {
      expect(Buffer.from(cipher.lookupDigest(other)).toString('hex')).not.toBe(digest);
    }
  });

  it('deux découpages différents des mêmes caractères ne se confondent pas', () => {
    const hex = (values: readonly string[]) =>
      Buffer.from(cipher.lookupDigest(values)).toString('hex');
    expect(hex(['PASSPORT', 'CD', 'OP1234567'])).not.toBe(hex(['PASSPORTCD', 'OP1234567']));
    expect(hex(['PASSPORT', 'CDOP', '1234567'])).not.toBe(hex(['PASSPORT', 'CD', 'OP1234567']));
    expect(hex(['A', ''])).not.toBe(hex(['', 'A']));
    expect(hex(['A'])).not.toBe(hex(['A', '']));
  });

  it('l’empreinte n’est pas un simple hachage : sans la clé, elle ne se recalcule pas', async () => {
    const { createHash, createHmac } = await import('node:crypto');
    const digest = Buffer.from(cipher.lookupDigest(parts)).toString('hex');
    expect(createHash('sha256').update(parts.join('')).digest('hex')).not.toBe(digest);
    // Ni un HMAC calculé directement avec la clé maîtresse : la clé de recherche en est dérivée.
    const direct = createHmac('sha256', Buffer.from(MASTER_KEY, 'base64'));
    for (const part of parts) {
      const bytes = Buffer.from(part, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      direct.update(length).update(bytes);
    }
    expect(direct.digest('hex')).not.toBe(digest);
  });
});

describe('KycCipher — clés', () => {
  it('refuse une clé maîtresse qui ne fait pas 32 octets', () => {
    for (const malformed of [
      Buffer.alloc(16, 1).toString('base64'),
      Buffer.alloc(33, 1).toString('base64'),
      '',
    ]) {
      expect(() => new KycCipher(malformed)).toThrow('The KYC encryption key must be 32 bytes.');
    }
  });

  it('chaque usage a sa propre clé : un chiffré d’un usage ne s’ouvre pas dans un autre', () => {
    // Une clé de fichier emballée n'est pas lisible comme un champ, et inversement.
    const sealed = cipher.sealDocument(content, CONTEXT);
    expect(() => cipher.decryptField(sealed.wrappedKey, CONTEXT)).toThrow(KycDecryptionError);
    const field = cipher.encryptField('x'.repeat(32), CONTEXT);
    expect(() =>
      cipher.openDocument({ ciphertext: sealed.ciphertext, wrappedKey: field }, CONTEXT),
    ).toThrow(KycDecryptionError);
  });
});
