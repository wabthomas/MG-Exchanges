import { describe, expect, it } from '@jest/globals';
import {
  KYC_DOCUMENT_CONTENT_TYPES,
  KYC_IDENTITY_DOCUMENT_TYPES,
  KYC_TWO_SIDED_IDENTITY_DOCUMENTS,
} from '@mgx/contracts';

import { detectContentType, fileExtensionOf } from './file-signature.js';
import {
  acceptedContentType,
  type AddressFacts,
  calendarDay,
  checkAddressDeclaration,
  checkIdentityDeclaration,
  type IdentityFacts,
  KYC_DOCUMENT_MIN_BYTES,
  KYC_DRAFT_SAVES_PER_ACCOUNT,
  KYC_SUBMISSIONS_PER_ACCOUNT,
  KYC_UPLOAD_RETRY_AFTER_SECONDS,
  KYC_UPLOADS_IN_FLIGHT_MAX,
  KYC_UPLOADS_PER_ACCOUNT,
  maskDocumentNumber,
  missingDocumentKinds,
} from './kyc-policy.js';

/** « Aujourd'hui » des contrôles : le 12 novembre 2026, en milieu de journée (UTC). */
const NOW = new Date('2026-11-12T10:30:00.000Z');

const identity = (overrides: {
  dateOfBirth?: string;
  document?: Partial<IdentityFacts['document']>;
}): IdentityFacts => ({
  dateOfBirth: overrides.dateOfBirth ?? '1990-05-17',
  document: {
    type: 'PASSPORT',
    issuingCountry: 'CD',
    issuedOn: '2024-01-10',
    expiresOn: '2029-01-09',
    ...overrides.document,
  },
});

const pathsOf = (errors: readonly { path: string }[]): string[] => errors.map(({ path }) => path);

describe('contrôle d’une déclaration d’identité', () => {
  it('accepte une pièce en cours de validité présentée par une personne majeure', () => {
    expect(checkIdentityDeclaration(identity({}), NOW)).toEqual([]);
  });

  it('le titulaire a dix-huit ans révolus au jour du contrôle', () => {
    expect(checkIdentityDeclaration(identity({ dateOfBirth: '2008-11-12' }), NOW)).toEqual([]);
    expect(checkIdentityDeclaration(identity({ dateOfBirth: '2008-11-13' }), NOW)).toEqual([
      { path: 'dateOfBirth', message: 'You must be at least 18 years old.' },
    ]);
    expect(
      pathsOf(
        checkIdentityDeclaration(
          identity({ dateOfBirth: '1899-12-31', document: { issuedOn: '1950-01-01' } }),
          NOW,
        ),
      ),
    ).toEqual(['dateOfBirth']);
    expect(
      pathsOf(checkIdentityDeclaration(identity({ dateOfBirth: '1990-02-30' }), NOW)),
    ).toContain('dateOfBirth');
  });

  it('la pièce n’est ni délivrée dans le futur, ni avant la naissance de son titulaire', () => {
    expect(
      checkIdentityDeclaration(identity({ document: { issuedOn: '2026-11-12' } }), NOW),
    ).toEqual([]);
    expect(
      checkIdentityDeclaration(identity({ document: { issuedOn: '2026-11-13' } }), NOW),
    ).toEqual([{ path: 'document.issuedOn', message: 'Must not be in the future.' }]);
    expect(
      checkIdentityDeclaration(identity({ document: { issuedOn: '1990-05-16' } }), NOW),
    ).toEqual([{ path: 'document.issuedOn', message: 'Must not be before the date of birth.' }]);
    expect(
      checkIdentityDeclaration(identity({ document: { issuedOn: '1990-05-17' } }), NOW),
    ).toEqual([]);
    expect(
      checkIdentityDeclaration(identity({ document: { issuedOn: '2024-02-30' } }), NOW),
    ).toEqual([{ path: 'document.issuedOn', message: 'Must be a valid calendar date.' }]);
  });

  it('une pièce expirée — y compris ce jour même — est refusée', () => {
    expect(
      checkIdentityDeclaration(identity({ document: { expiresOn: '2026-11-13' } }), NOW),
    ).toEqual([]);
    for (const expiresOn of ['2026-11-12', '2026-11-11', '2025-01-01']) {
      expect(checkIdentityDeclaration(identity({ document: { expiresOn } }), NOW)).toEqual([
        {
          path: 'document.expiresOn',
          message: 'The document has expired: a valid document is required.',
        },
      ]);
    }
    expect(
      checkIdentityDeclaration(identity({ document: { expiresOn: '2029-02-30' } }), NOW),
    ).toEqual([{ path: 'document.expiresOn', message: 'Must be a valid calendar date.' }]);
  });

  it('le jour civil est celui d’UTC, jusqu’à la dernière seconde', () => {
    const lastSecond = new Date('2026-11-12T23:59:59.999Z');
    const firstSecond = new Date('2026-11-13T00:00:00.000Z');
    const expiring = identity({ document: { expiresOn: '2026-11-13' } });
    expect(checkIdentityDeclaration(expiring, lastSecond)).toEqual([]);
    expect(pathsOf(checkIdentityDeclaration(expiring, firstSecond))).toEqual([
      'document.expiresOn',
    ]);
    expect(calendarDay(lastSecond)).toBe('2026-11-12');
    expect(calendarDay(firstSecond)).toBe('2026-11-13');
  });

  it('un passeport porte une date d’expiration ; les autres pièces peuvent ne pas en avoir', () => {
    expect(checkIdentityDeclaration(identity({ document: { expiresOn: null } }), NOW)).toEqual([
      { path: 'document.expiresOn', message: 'Is required for a passport.' },
    ]);
    for (const type of KYC_IDENTITY_DOCUMENT_TYPES.filter((other) => other !== 'PASSPORT')) {
      expect(
        checkIdentityDeclaration(identity({ document: { type, expiresOn: null } }), NOW),
      ).toEqual([]);
    }
  });

  it('la carte d’électeur ne vaut pièce d’identité que délivrée par la RDC', () => {
    expect(
      checkIdentityDeclaration(
        identity({ document: { type: 'VOTER_CARD', issuingCountry: 'CD', expiresOn: null } }),
        NOW,
      ),
    ).toEqual([]);
    expect(
      checkIdentityDeclaration(
        identity({ document: { type: 'VOTER_CARD', issuingCountry: 'CG', expiresOn: null } }),
        NOW,
      ),
    ).toEqual([
      {
        path: 'document.issuingCountry',
        message: 'This type of document is only accepted when issued by: CD.',
      },
    ]);
    // Les autres pièces sont acceptées quel que soit le pays qui les a délivrées.
    for (const type of ['PASSPORT', 'NATIONAL_ID_CARD', 'DRIVING_LICENCE'] as const) {
      expect(
        checkIdentityDeclaration(identity({ document: { type, issuingCountry: 'FR' } }), NOW),
      ).toEqual([]);
    }
  });

  it('signale toutes les erreurs à la fois', () => {
    expect(
      pathsOf(
        checkIdentityDeclaration(
          identity({
            dateOfBirth: '2015-01-01',
            document: {
              type: 'VOTER_CARD',
              issuingCountry: 'AO',
              issuedOn: '2027-01-01',
              expiresOn: '2020-01-01',
            },
          }),
          NOW,
        ),
      ),
    ).toEqual([
      'dateOfBirth',
      'document.issuedOn',
      'document.expiresOn',
      'document.issuingCountry',
    ]);
  });
});

describe('contrôle d’une déclaration d’adresse', () => {
  const address = (issuedOn: string, country = 'CD'): AddressFacts => ({
    country,
    proof: { issuedOn },
  });

  it('accepte un justificatif récent, à une adresse du pays du compte', () => {
    expect(checkAddressDeclaration(address('2026-10-20'), 'CD', NOW)).toEqual([]);
    expect(checkAddressDeclaration(address('2026-11-12'), 'CD', NOW)).toEqual([]);
  });

  it('l’adresse est dans le pays de résidence du compte', () => {
    expect(checkAddressDeclaration(address('2026-10-20', 'CG'), 'CD', NOW)).toEqual([
      { path: 'country', message: 'Must be the country of residence of the account (CD).' },
    ]);
    expect(checkAddressDeclaration(address('2026-10-20', 'CG'), 'CG', NOW)).toEqual([]);
  });

  it('le justificatif date de 92 jours au plus, et pas du futur', () => {
    // 92 jours avant le 12 novembre 2026 : le 12 août 2026.
    expect(checkAddressDeclaration(address('2026-08-12'), 'CD', NOW)).toEqual([]);
    expect(checkAddressDeclaration(address('2026-08-11'), 'CD', NOW)).toEqual([
      {
        path: 'proof.issuedOn',
        message: 'The proof of address must be less than 92 days old.',
      },
    ]);
    expect(checkAddressDeclaration(address('2026-11-13'), 'CD', NOW)).toEqual([
      { path: 'proof.issuedOn', message: 'Must not be in the future.' },
    ]);
    expect(checkAddressDeclaration(address('2026-09-31'), 'CD', NOW)).toEqual([
      { path: 'proof.issuedOn', message: 'Must be a valid calendar date.' },
    ]);
  });

  it('signale le pays et la date à la fois', () => {
    expect(pathsOf(checkAddressDeclaration(address('2020-01-01', 'FR'), 'CD', NOW))).toEqual([
      'country',
      'proof.issuedOn',
    ]);
  });
});

describe('pièces qu’il reste à joindre', () => {
  it('niveau 1 : recto et autoportrait ; le verso en plus pour une pièce à deux faces', () => {
    expect(missingDocumentKinds(1, 'PASSPORT', [])).toEqual(['IDENTITY_FRONT', 'SELFIE']);
    expect(missingDocumentKinds(1, 'PASSPORT', ['IDENTITY_FRONT'])).toEqual(['SELFIE']);
    expect(missingDocumentKinds(1, 'PASSPORT', ['SELFIE', 'IDENTITY_FRONT'])).toEqual([]);
    // Un verso joint à un passeport ne gêne pas.
    expect(
      missingDocumentKinds(1, 'PASSPORT', ['SELFIE', 'IDENTITY_FRONT', 'IDENTITY_BACK']),
    ).toEqual([]);

    for (const type of KYC_TWO_SIDED_IDENTITY_DOCUMENTS) {
      expect(missingDocumentKinds(1, type, [])).toEqual([
        'IDENTITY_FRONT',
        'IDENTITY_BACK',
        'SELFIE',
      ]);
      expect(missingDocumentKinds(1, type, ['IDENTITY_FRONT', 'SELFIE'])).toEqual([
        'IDENTITY_BACK',
      ]);
      expect(missingDocumentKinds(1, type, ['IDENTITY_FRONT', 'IDENTITY_BACK', 'SELFIE'])).toEqual(
        [],
      );
    }
  });

  it('niveaux 2 et 3 : au moins une pièce de la nature attendue', () => {
    expect(missingDocumentKinds(2, null, [])).toEqual(['PROOF_OF_ADDRESS']);
    expect(missingDocumentKinds(2, null, ['PROOF_OF_ADDRESS'])).toEqual([]);
    expect(missingDocumentKinds(2, null, ['PROOF_OF_ADDRESS', 'PROOF_OF_ADDRESS'])).toEqual([]);
    expect(missingDocumentKinds(3, null, [])).toEqual(['SOURCE_OF_FUNDS']);
    expect(missingDocumentKinds(3, null, ['SOURCE_OF_FUNDS'])).toEqual([]);
    // Une pièce d'une autre nature ne compte pas.
    expect(missingDocumentKinds(2, null, ['SOURCE_OF_FUNDS'])).toEqual(['PROOF_OF_ADDRESS']);
    expect(missingDocumentKinds(3, null, ['SELFIE'])).toEqual(['SOURCE_OF_FUNDS']);
  });
});

describe('numéro de pièce rendu à son titulaire', () => {
  it('ne laisse lire que la fin : trois caractères au plus, jamais plus du tiers', () => {
    expect(maskDocumentNumber('OP1234567')).toBe('••••567');
    expect(maskDocumentNumber('A'.repeat(29) + 'XYZ')).toBe('••••XYZ');
    expect(maskDocumentNumber('ABCDEFGH')).toBe('••••GH');
    expect(maskDocumentNumber('ABCDEF')).toBe('••••EF');
    expect(maskDocumentNumber('ABCD')).toBe('••••D');
    expect(maskDocumentNumber('ABC')).toBe('••••C');
    expect(maskDocumentNumber('AB')).toBe('••••');
    expect(maskDocumentNumber('')).toBe('••••');
  });

  it('le masque ne révèle pas la longueur du numéro', () => {
    expect(maskDocumentNumber('1234567890123456789012345678901Z')).toHaveLength(7);
    expect(maskDocumentNumber('123456789')).toHaveLength(7);
  });
});

describe('type annoncé d’un envoi', () => {
  it('reconnaît les trois formats acceptés, sans tenir compte de la casse ni des paramètres', () => {
    for (const type of KYC_DOCUMENT_CONTENT_TYPES) {
      expect(acceptedContentType(type)).toBe(type);
      expect(acceptedContentType(type.toUpperCase())).toBe(type);
      expect(acceptedContentType(` ${type} ; charset=binary`)).toBe(type);
    }
  });

  it('refuse tout le reste', () => {
    for (const header of [
      undefined,
      '',
      'image/gif',
      'image/svg+xml',
      'text/html',
      'application/json',
      'application/octet-stream',
      'multipart/form-data; boundary=x',
      'image/jpeg2000',
      'image/jpegx',
      'ximage/jpeg',
      'image/*',
      '*/*',
      'text/plain; x=image/png',
      'image/png, image/gif',
    ]) {
      expect(acceptedContentType(header)).toBeNull();
    }
  });
});

describe('type réel d’un fichier', () => {
  const withSignature = (signature: readonly number[], size = 64): Buffer => {
    const content = Buffer.alloc(size, 0x41);
    Buffer.from(signature).copy(content);
    return content;
  };

  it('se lit sur les premiers octets', () => {
    expect(detectContentType(withSignature([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectContentType(withSignature([0xff, 0xd8, 0xff, 0xe1]))).toBe('image/jpeg');
    expect(detectContentType(withSignature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(detectContentType(Buffer.from('%PDF-1.7\n…'))).toBe('application/pdf');
    // La signature seule suffit.
    expect(detectContentType(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(detectContentType(Buffer.from('%PDF-'))).toBe('application/pdf');
  });

  it('ne reconnaît ni un format voisin, ni une signature incomplète ou décalée', () => {
    for (const content of [
      Buffer.alloc(0),
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xd8, 0x00, 0xff]),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]),
      withSignature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00]),
      Buffer.from('%PDF'),
      Buffer.from('%pdf-1.7'),
      Buffer.from(' %PDF-1.7'),
      Buffer.from('GIF89a…'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      Buffer.from('<html><script>alert(1)</script></html>'),
      Buffer.from('PK\u0003\u0004 archive'),
      withSignature([0x00, 0xff, 0xd8, 0xff]),
    ]) {
      expect(detectContentType(content)).toBeNull();
    }
  });

  it('chaque format a son extension, pour le nom du fichier rendu au back-office', () => {
    expect(KYC_DOCUMENT_CONTENT_TYPES.map(fileExtensionOf)).toEqual(['jpg', 'png', 'pdf']);
  });
});

describe('limites', () => {
  it('quotas par compte, taille minimale et réceptions simultanées : valeurs de départ', () => {
    expect(KYC_DOCUMENT_MIN_BYTES).toBe(1024);
    expect(KYC_DRAFT_SAVES_PER_ACCOUNT).toEqual({ limit: 30, windowMs: 3_600_000 });
    expect(KYC_UPLOADS_PER_ACCOUNT).toEqual({ limit: 40, windowMs: 3_600_000 });
    expect(KYC_SUBMISSIONS_PER_ACCOUNT).toEqual({ limit: 5, windowMs: 86_400_000 });
    expect(KYC_UPLOADS_IN_FLIGHT_MAX).toBe(8);
    expect(KYC_UPLOAD_RETRY_AFTER_SECONDS).toBe(5);
  });
});
