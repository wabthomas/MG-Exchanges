import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { DocumentStorage } from '../application/document-storage.js';

/** Forme d'une clé d'emplacement : segments de minuscules, chiffres et tirets. */
const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Stockage des pièces sur un système de fichiers : un répertoire local, ou un volume partagé
 * par les instances de l'API.
 *
 *  - une écriture est **atomique** (fichier temporaire, puis renommage) et **durable** (le
 *    contenu puis le répertoire sont synchronisés sur le disque avant de répondre) : un fichier
 *    n'est jamais visible à moitié écrit ;
 *  - fichiers et répertoires ne sont accessibles qu'au compte qui exécute l'API ;
 *  - une clé ne peut pas désigner un emplacement hors du répertoire racine.
 */
export class FilesystemDocumentStorage extends DocumentStorage {
  private readonly root: string;

  constructor(root: string) {
    super();
    this.root = resolve(root);
  }

  /** Crée le répertoire racine s'il n'existe pas, et vérifie qu'il est accessible en écriture. */
  async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const probe = join(this.root, `.probe-${randomBytes(8).toString('hex')}`);
    const handle = await open(probe, 'wx', 0o600);
    await handle.close();
    await unlink(probe);
  }

  async put(key: string, content: Uint8Array): Promise<void> {
    const path = this.pathOf(key);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      // `wx` : la création échoue si le fichier existe — jamais d'écriture à travers un lien.
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    // Le renommage n'est durable qu'une fois le répertoire lui-même synchronisé.
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathOf(key));
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }

  private pathOf(key: string): string {
    if (!STORAGE_KEY_PATTERN.test(key)) {
      throw new Error('Invalid storage key.');
    }
    const path = resolve(this.root, key);
    // Défense en profondeur : la forme de la clé exclut déjà `..` et les chemins absolus.
    if (!path.startsWith(this.root + sep)) {
      throw new Error('Invalid storage key.');
    }
    return path;
  }
}
