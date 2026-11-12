import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  KycAddressDeclaration,
  KycDocumentContentType,
  KycFundsDeclaration,
  KycIdentityDeclaration,
} from '@mgx/contracts';

import { testClock } from './test-app.js';

/** Clé de test uniquement : elle n'existe dans aucun environnement réel. */
export const TEST_KYC_ENCRYPTION_KEY = Buffer.from('test-only-kyc-documents-key-0001').toString(
  'base64',
);

export interface KycTestStorage {
  /** Variables à passer à `createTestApp({ env })` pour rendre la vérification utilisable. */
  readonly env: Record<string, string>;
  readonly directory: string;
  /** Chemins (relatifs au répertoire) des fichiers présents dans le stockage. */
  files(): string[];
  /** Contenu brut — chiffré — d'un fichier du stockage. */
  read(relativePath: string): Buffer;
  remove(): void;
}

/** Répertoire temporaire servant de stockage des pièces le temps d'un fichier de test. */
export function createKycStorage(): KycTestStorage {
  const directory = mkdtempSync(join(tmpdir(), 'mgx-kyc-test-'));
  const walk = (current: string): string[] =>
    readdirSync(current).flatMap((entry) => {
      const path = join(current, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return {
    env: { KYC_STORAGE_DIR: directory, KYC_ENCRYPTION_KEY: TEST_KYC_ENCRYPTION_KEY },
    directory,
    files: () =>
      walk(directory)
        .map((path) => path.slice(directory.length + 1))
        .sort(),
    read: (relativePath) => readFileSync(join(directory, relativePath)),
    remove: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const SIGNATURES: Readonly<Record<KycDocumentContentType, Buffer>> = {
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'application/pdf': Buffer.from('%PDF-1.7\n', 'latin1'),
};

export interface TestFile {
  readonly contentType: KycDocumentContentType;
  readonly content: Buffer;
}

/**
 * Fichier de test : la signature du format, suivie d'octets dérivés de `label` — un même
 * libellé donne toujours le même fichier, deux libellés différents jamais.
 */
export function testFile(
  contentType: KycDocumentContentType,
  label: string,
  byteSize = 2048,
): TestFile {
  const signature = SIGNATURES[contentType];
  const content = Buffer.alloc(byteSize);
  signature.copy(content);
  let block = createHash('sha256').update(label).digest();
  for (let offset = signature.length; offset < byteSize; offset += block.length) {
    block.copy(content, offset);
    block = createHash('sha256').update(block).digest();
  }
  return { contentType, content };
}

export const jpeg = (label: string, byteSize?: number): TestFile =>
  testFile('image/jpeg', label, byteSize);
export const png = (label: string, byteSize?: number): TestFile =>
  testFile('image/png', label, byteSize);
export const pdf = (label: string, byteSize?: number): TestFile =>
  testFile('application/pdf', label, byteSize);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Jour civil (UTC), décalé de `days` jours par rapport à l'horloge des tests. */
export function dayFromNow(days: number): string {
  return new Date(testClock.now().getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

let documentCounter = 0;

/** Numéro de pièce d'identité jamais encore utilisé dans ce fichier de test. */
export function newDocumentNumber(): string {
  documentCounter += 1;
  return `OP${String(documentCounter).padStart(7, '0')}`;
}

type IdentityOverrides = Partial<Omit<KycIdentityDeclaration, 'document'>> & {
  readonly document?: Partial<KycIdentityDeclaration['document']>;
};

/** Déclaration d'identité valide : un passeport congolais, au numéro unique sauf mention contraire. */
export function identityDeclaration(overrides: IdentityOverrides = {}): KycIdentityDeclaration {
  const { document, ...identity } = overrides;
  return {
    givenName: 'Jean',
    familyName: 'Mukendi',
    additionalName: 'Kabongo',
    dateOfBirth: '1990-05-17',
    placeOfBirth: 'Lubumbashi',
    nationality: 'CD',
    ...identity,
    document: {
      type: 'PASSPORT',
      number: newDocumentNumber(),
      issuingCountry: 'CD',
      issuedOn: dayFromNow(-400),
      issuedAt: 'Kinshasa',
      expiresOn: dayFromNow(1400),
      ...document,
    },
  };
}

type AddressOverrides = Partial<Omit<KycAddressDeclaration, 'proof'>> & {
  readonly proof?: Partial<KycAddressDeclaration['proof']>;
};

export function addressDeclaration(overrides: AddressOverrides = {}): KycAddressDeclaration {
  const { proof, ...address } = overrides;
  return {
    addressLine1: '12 avenue Kasa-Vubu',
    addressLine2: null,
    city: 'Kinshasa',
    region: 'Kinshasa',
    postalCode: null,
    country: 'CD',
    ...address,
    proof: { type: 'UTILITY_BILL', issuedOn: dayFromNow(-20), ...proof },
  };
}

export function fundsDeclaration(
  overrides: Partial<KycFundsDeclaration> = {},
): KycFundsDeclaration {
  return {
    sources: ['EMPLOYMENT', 'SAVINGS'],
    occupation: 'Ingénieur des mines',
    employerName: 'Société minière du Katanga',
    explanation: 'Salaire mensuel versé par mon employeur, et épargne constituée depuis 2015.',
    ...overrides,
  };
}
