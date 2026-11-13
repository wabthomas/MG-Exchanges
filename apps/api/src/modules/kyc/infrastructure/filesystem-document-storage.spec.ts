import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { FilesystemDocumentStorage } from './filesystem-document-storage.js';

const KEY = '1d/0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const content = Buffer.from('contenu déjà chiffré par l’appelant');

describe('FilesystemDocumentStorage', () => {
  let parent: string;
  let root: string;
  let storage: FilesystemDocumentStorage;

  const allFiles = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? allFiles(path) : [path];
    });

  beforeEach(async () => {
    parent = mkdtempSync(join(tmpdir(), 'mgx-storage-spec-'));
    root = join(parent, 'kyc');
    storage = new FilesystemDocumentStorage(root);
    await storage.prepare();
  });

  afterEach(() => {
    chmodSync(root, 0o700);
    rmSync(parent, { recursive: true, force: true });
  });

  it('prépare un répertoire réservé au compte de l’API, sans y laisser de fichier témoin', () => {
    expect(statSync(root).isDirectory()).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(readdirSync(root)).toEqual([]);
  });

  it('ce qui est écrit se relit à l’identique ; fichier et répertoire sont privés', async () => {
    await storage.put(KEY, content);

    expect((await storage.get(KEY))?.equals(content)).toBe(true);
    expect(allFiles(root)).toEqual([join(root, KEY)]);
    expect(statSync(join(root, KEY)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, '1d')).mode & 0o777).toBe(0o700);
  });

  it('une écriture ne laisse aucun fichier temporaire derrière elle', async () => {
    await storage.put(KEY, content);
    await storage.put('1d/second', Buffer.alloc(100_000, 7));
    expect(allFiles(root).sort()).toEqual([join(root, KEY), join(root, '1d/second')].sort());
    expect(allFiles(root).some((path) => path.endsWith('.tmp'))).toBe(false);
  });

  it('réécrire un emplacement remplace son contenu d’un seul tenant', async () => {
    await storage.put(KEY, content);
    await storage.put(KEY, Buffer.from('nouveau contenu'));
    expect((await storage.get(KEY))?.toString()).toBe('nouveau contenu');
    expect(allFiles(root)).toHaveLength(1);
  });

  it('un emplacement absent se lit `null` ; l’effacer deux fois est sans effet', async () => {
    expect(await storage.get(KEY)).toBeNull();
    await storage.delete(KEY);

    await storage.put(KEY, content);
    await storage.delete(KEY);
    expect(existsSync(join(root, KEY))).toBe(false);
    expect(await storage.get(KEY)).toBeNull();
    await storage.delete(KEY);
  });

  it('une clé ne désigne jamais un emplacement hors du répertoire', async () => {
    const outside = join(parent, 'outside');
    writeFileSync(outside, 'secret');

    for (const key of [
      '../outside',
      '1d/../../outside',
      '/etc/passwd',
      outside,
      '..',
      '.',
      '',
      '1d/',
      '/1d',
      '1d//x',
      '1d/.hidden',
      '1D/Upper',
      '1d/a b',
      '1d\\x',
      '1d/x\0',
      '1d/%2e%2e/x',
    ]) {
      await expect(storage.put(key, content)).rejects.toThrow('Invalid storage key.');
      await expect(storage.get(key)).rejects.toThrow('Invalid storage key.');
      await expect(storage.delete(key)).rejects.toThrow('Invalid storage key.');
    }
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(outside)).toBe(true);
  });

  it('un échec d’écriture est signalé et ne laisse pas de fichier à moitié écrit', async () => {
    // Un fichier occupe la place du répertoire attendu : l'écriture ne peut pas aboutir.
    writeFileSync(join(root, '1d'), 'pas un répertoire');
    await expect(storage.put(KEY, content)).rejects.toThrow();
    expect(allFiles(root)).toEqual([join(root, '1d')]);
    expect(await storage.get('2e/other')).toBeNull();
  });

  it('une erreur de lecture autre que l’absence n’est pas confondue avec « introuvable »', async () => {
    // L'emplacement est un répertoire : ce n'est pas « absent », c'est une anomalie.
    await storage.put('1d/x/inner', content);
    await expect(storage.get('1d/x')).rejects.toThrow();
    await expect(storage.delete('1d/x')).rejects.toThrow();
  });

  it('n’écrit pas à travers un lien placé à l’emplacement du fichier temporaire ou final', async () => {
    const target = join(parent, 'target');
    writeFileSync(target, 'intact');
    await storage.put('1d/seed', content);
    // Un lien symbolique à l'emplacement final : le renommage le remplace, sans le suivre.
    symlinkSync(target, join(root, KEY));
    await storage.put(KEY, content);
    expect((await storage.get(KEY))?.equals(content)).toBe(true);
    expect(statSync(target).size).toBe('intact'.length);
  });

  it('au démarrage, un répertoire où l’on ne peut pas écrire est une erreur', async () => {
    if (process.getuid?.() === 0) {
      // Le super-utilisateur écrit partout : le contrôle n'a pas de sens sous ce compte.
      return;
    }
    chmodSync(root, 0o500);
    await expect(new FilesystemDocumentStorage(root).prepare()).rejects.toThrow(/EACCES/);
  });

  it('au démarrage, un répertoire existant est repris tel quel, avec son contenu', async () => {
    await storage.put(KEY, content);
    const again = new FilesystemDocumentStorage(root);
    await again.prepare();
    expect((await again.get(KEY))?.equals(content)).toBe(true);
  });
});
