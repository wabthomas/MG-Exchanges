import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { PasswordHasher } from '../application/password-hasher.js';
import { normalizePassword } from '../domain/password-policy.js';

const argon2Async = promisify(argon2);

const ALGORITHM = 'argon2id';
const VERSION = 19;
const SALT_BYTES = 16;
const TAG_BYTES = 32;
const PARALLELISM = 1;

/** Bornes acceptées à la vérification : une empreinte altérée ne doit pas épuiser la mémoire. */
const MAX_MEMORY_KIB = 1_048_576;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 8;

// Format PHC : $argon2id$v=19$m=<Kio>,t=<passes>,p=<parallélisme>$<sel>$<empreinte> (base64 sans « = »).
const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{11,86})\$([A-Za-z0-9+/]{22,172})$/;

export interface Argon2Cost {
  readonly memoryKib: number;
  readonly passes: number;
}

interface ParsedHash {
  readonly memoryKib: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly salt: Buffer;
  readonly tag: Buffer;
}

function encodeBase64(value: Buffer): string {
  return value.toString('base64').replace(/=+$/, '');
}

function parse(hash: string): ParsedHash | null {
  const match = PHC_PATTERN.exec(hash);
  if (match === null) {
    return null;
  }
  const parsed: ParsedHash = {
    memoryKib: Number(match[1]),
    passes: Number(match[2]),
    parallelism: Number(match[3]),
    salt: Buffer.from(match[4] ?? '', 'base64'),
    tag: Buffer.from(match[5] ?? '', 'base64'),
  };
  const withinBounds =
    parsed.memoryKib >= 8 * parsed.parallelism &&
    parsed.memoryKib <= MAX_MEMORY_KIB &&
    parsed.passes >= 1 &&
    parsed.passes <= MAX_PASSES &&
    parsed.parallelism >= 1 &&
    parsed.parallelism <= MAX_PARALLELISM &&
    parsed.salt.length >= 8 &&
    parsed.tag.length >= 16;
  return withinBounds ? parsed : null;
}

function derive(
  password: string,
  salt: Buffer,
  cost: { memoryKib: number; passes: number; parallelism: number },
  tagLength: number,
): Promise<Buffer> {
  return argon2Async(ALGORITHM, {
    message: Buffer.from(normalizePassword(password), 'utf8'),
    nonce: salt,
    memory: cost.memoryKib,
    passes: cost.passes,
    parallelism: cost.parallelism,
    tagLength,
  });
}

/**
 * Hachage Argon2id (RFC 9106) par l'implémentation native de Node.js — aucune dépendance.
 *
 * L'empreinte est au format PHC : elle porte ses paramètres, ce qui permet de les renforcer
 * dans le temps (une empreinte ancienne est recalculée à la connexion suivante). Le calcul
 * s'exécute hors du fil principal ; le nombre de calculs simultanés est borné par le groupe
 * de fils de Node.js.
 */
export class Argon2PasswordHasher extends PasswordHasher {
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly cost: Argon2Cost) {
    super();
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const tag = await derive(password, salt, { ...this.cost, parallelism: PARALLELISM }, TAG_BYTES);
    const { memoryKib, passes } = this.cost;
    return `$${ALGORITHM}$v=${VERSION}$m=${memoryKib},t=${passes},p=${PARALLELISM}$${encodeBase64(salt)}$${encodeBase64(tag)}`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    const parsed = parse(hash);
    if (parsed === null) {
      return false;
    }
    const tag = await derive(password, parsed.salt, parsed, parsed.tag.length);
    return timingSafeEqual(tag, parsed.tag);
  }

  needsRehash(hash: string): boolean {
    const parsed = parse(hash);
    return (
      parsed?.memoryKib !== this.cost.memoryKib ||
      parsed.passes !== this.cost.passes ||
      parsed.parallelism !== PARALLELISM ||
      parsed.tag.length !== TAG_BYTES
    );
  }

  async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash(randomBytes(32).toString('hex'));
    await this.verify(await this.dummyHash, password);
  }
}
