import { createHash } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { AppError } from '../../../common/errors/app-error.js';
import { KycCipher } from '../infrastructure/kyc-cipher.js';
import { DocumentStorage } from './document-storage.js';
import { DocumentUnreadableError, KycVault } from './kyc-vault.js';

/** Stockage en mémoire : ce que le coffre lui confie reste observable. */
class MemoryStorage extends DocumentStorage {
  readonly files = new Map<string, Buffer>();
  prepared = 0;

  prepare(): Promise<void> {
    this.prepared += 1;
    return Promise.resolve();
  }

  put(key: string, content: Uint8Array): Promise<void> {
    this.files.set(key, Buffer.from(content));
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer | null> {
    return Promise.resolve(this.files.get(key) ?? null);
  }

  delete(key: string): Promise<void> {
    this.files.delete(key);
    return Promise.resolve();
  }
}

const MASTER_KEY = Buffer.from('unit-test-kyc-vault-master-key-1').toString('base64');
const DOCUMENT = {
  id: '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d',
  caseId: '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0aaa',
  kind: 'IDENTITY_FRONT',
} as const;
const USER = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0bbb';
const content = Buffer.from('\u00ff\u00d8\u00ff photographie d’une carte d’électeur', 'latin1');

function configured() {
  const storage = new MemoryStorage();
  return { storage, vault: new KycVault({ cipher: new KycCipher(MASTER_KEY), storage }) };
}

describe('KycVault — pièces', () => {
  it('range la pièce chiffrée dans un répertoire tiré de la fin de son identifiant', async () => {
    const { vault, storage } = configured();

    const stored = await vault.storeDocument(DOCUMENT, content);

    expect(stored.storageKey).toBe(`1d/${DOCUMENT.id}`);
    expect([...storage.files.keys()]).toEqual([stored.storageKey]);
    expect(Buffer.from(stored.sha256).toString('hex')).toBe(
      createHash('sha256').update(content).digest('hex'),
    );
    // Le stockage ne reçoit jamais la pièce en clair.
    const file = storage.files.get(stored.storageKey);
    expect(file?.includes(content.subarray(3, 20))).toBe(false);
    expect(file).toHaveLength(content.length + 29);
  });

  it('relit la pièce à l’identique', async () => {
    const { vault } = configured();
    const stored = await vault.storeDocument(DOCUMENT, content);
    expect((await vault.loadDocument(DOCUMENT, stored)).equals(content)).toBe(true);
  });

  it('un fichier disparu, altéré ou échangé n’est jamais rendu', async () => {
    const { vault, storage } = configured();
    const stored = await vault.storeDocument(DOCUMENT, content);
    const other = await vault.storeDocument(
      { ...DOCUMENT, id: '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c2e' },
      Buffer.from('une autre pièce'),
    );
    const original = storage.files.get(stored.storageKey);
    if (original === undefined) {
      throw new Error('Missing stored file.');
    }

    // Altéré.
    const corrupted = Buffer.from(original);
    corrupted[20] = (corrupted[20] ?? 0) ^ 0xff;
    storage.files.set(stored.storageKey, corrupted);
    await expect(vault.loadDocument(DOCUMENT, stored)).rejects.toThrow(
      'Verification document cannot be read: UNDECRYPTABLE.',
    );

    // Échangé avec le fichier d'une autre pièce.
    storage.files.set(stored.storageKey, storage.files.get(other.storageKey) ?? Buffer.alloc(0));
    await expect(vault.loadDocument(DOCUMENT, stored)).rejects.toThrow(DocumentUnreadableError);

    // Disparu.
    storage.files.delete(stored.storageKey);
    await expect(vault.loadDocument(DOCUMENT, stored)).rejects.toThrow(
      'Verification document cannot be read: MISSING.',
    );

    // Remis en place, il se relit.
    storage.files.set(stored.storageKey, original);
    expect((await vault.loadDocument(DOCUMENT, stored)).equals(content)).toBe(true);
  });

  it('une pièce ne se relit que comme ce qu’elle est : même dossier, même nature, même identifiant', async () => {
    const { vault } = configured();
    const stored = await vault.storeDocument(DOCUMENT, content);
    for (const identity of [
      { ...DOCUMENT, kind: 'SELFIE' as const },
      { ...DOCUMENT, caseId: '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0fff' },
      { ...DOCUMENT, id: '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c2e' },
    ]) {
      await expect(vault.loadDocument(identity, stored)).rejects.toThrow(
        'Verification document cannot be read: UNDECRYPTABLE.',
      );
    }
  });

  it('un contenu qui se déchiffre mais ne correspond plus à l’empreinte enregistrée est refusé', async () => {
    const { vault } = configured();
    const stored = await vault.storeDocument(DOCUMENT, content);
    const wrongDigest = new Uint8Array(createHash('sha256').update('autre contenu').digest());

    await expect(vault.loadDocument(DOCUMENT, { ...stored, sha256: wrongDigest })).rejects.toThrow(
      'Verification document cannot be read: CORRUPTED.',
    );
    await expect(
      vault.loadDocument(DOCUMENT, { ...stored, sha256: new Uint8Array(20) }),
    ).rejects.toThrow('Verification document cannot be read: CORRUPTED.');
  });

  it('effacer une pièce retire son fichier ; l’effacer de nouveau est sans effet', async () => {
    const { vault, storage } = configured();
    const stored = await vault.storeDocument(DOCUMENT, content);
    await vault.removeDocument(stored.storageKey);
    expect(storage.files.size).toBe(0);
    await vault.removeDocument(stored.storageKey);
  });
});

describe('KycVault — numéros de pièce d’identité', () => {
  it('un numéro se relit pour le compte qui l’a déclaré, et pour lui seul', () => {
    const { vault } = configured();
    const encrypted = vault.encryptDocumentNumber(USER, 'OP1234567');

    expect(Buffer.from(encrypted).includes('OP1234567')).toBe(false);
    expect(vault.decryptDocumentNumber(USER, encrypted)).toBe('OP1234567');
    expect(() =>
      vault.decryptDocumentNumber('0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0ccc', encrypted),
    ).toThrow('Encrypted verification data cannot be decrypted.');
  });

  it('la même pièce a la même empreinte quel que soit le compte ; une autre pièce, une autre empreinte', () => {
    const { vault } = configured();
    const hex = (type: 'PASSPORT' | 'VOTER_CARD', country: string, number: string) =>
      Buffer.from(vault.documentNumberDigest(type, country, number)).toString('hex');

    expect(hex('PASSPORT', 'CD', 'OP1234567')).toBe(hex('PASSPORT', 'CD', 'OP1234567'));
    expect(hex('PASSPORT', 'CD', 'OP1234567')).toHaveLength(64);
    expect(hex('VOTER_CARD', 'CD', 'OP1234567')).not.toBe(hex('PASSPORT', 'CD', 'OP1234567'));
    expect(hex('PASSPORT', 'CG', 'OP1234567')).not.toBe(hex('PASSPORT', 'CD', 'OP1234567'));
    expect(hex('PASSPORT', 'CD', 'OP1234568')).not.toBe(hex('PASSPORT', 'CD', 'OP1234567'));
    // L'empreinte ne contient pas le numéro.
    expect(hex('PASSPORT', 'CD', 'OP1234567')).not.toContain(
      Buffer.from('OP1234567').toString('hex'),
    );
  });
});

describe('KycVault — sans stockage chiffré configuré', () => {
  const vault = new KycVault(null);
  const unavailable = (work: () => unknown): void => {
    try {
      work();
      throw new Error('The vault should be unavailable.');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('SERVICE_UNAVAILABLE');
    }
  };

  it('se déclare indisponible, et démarre sans rien préparer', async () => {
    expect(vault.available).toBe(false);
    unavailable(() => {
      vault.assertAvailable();
    });
    await vault.prepare();
  });

  it('aucune opération n’écrit ni ne lit quoi que ce soit', async () => {
    unavailable(() => vault.encryptDocumentNumber(USER, 'OP1234567'));
    unavailable(() => vault.decryptDocumentNumber(USER, new Uint8Array(40)));
    unavailable(() => vault.documentNumberDigest('PASSPORT', 'CD', 'OP1234567'));
    await expect(vault.storeDocument(DOCUMENT, content)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    await expect(
      vault.loadDocument(DOCUMENT, {
        storageKey: `1d/${DOCUMENT.id}`,
        wrappedKey: new Uint8Array(61),
        sha256: new Uint8Array(32),
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(vault.removeDocument(`1d/${DOCUMENT.id}`)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('configuré, il se déclare disponible et prépare son stockage au démarrage', async () => {
    const { vault: ready, storage } = configured();
    expect(ready.available).toBe(true);
    ready.assertAvailable();
    await ready.prepare();
    expect(storage.prepared).toBe(1);
  });
});
