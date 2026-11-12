import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import {
  type KycDeclaration,
  KycRuleViolationError,
} from '../../src/modules/kyc/application/kyc-case.repository.js';
import { PrismaKycCaseRepository } from '../../src/modules/kyc/infrastructure/prisma-kyc-case.repository.js';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Un service lit un dossier, puis l'écrit : entre les deux, une autre requête a pu le déposer,
 * le décider ou le retirer. Chaque écriture porte donc elle-même sa condition, et **dit** si
 * elle s'est appliquée. C'est ce contrat du port de persistance qui est vérifié ici, sur
 * PostgreSQL, sans les contrôles que les services font avant d'écrire.
 */
describe('Dossiers de vérification — écritures conditionnelles (PostgreSQL réel)', () => {
  let database: TestDatabase;
  let app: PrismaClient;
  let reviewer: string;
  const repository = new PrismaKycCaseRepository();
  const now = new Date('2026-11-12T10:00:00.000Z');
  const later = new Date(now.getTime() + 60_000);

  beforeAll(async () => {
    database = await createTestDatabase();
    app = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.appUrl }) });

    // Un agent de conformité, nommé comme le fait l'outil d'amorçage : par le propriétaire.
    reviewer = await createUser();
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: database.ownerUrl }),
    });
    try {
      const role = await owner.role.findUniqueOrThrow({ where: { key: 'compliance' } });
      await owner.userRole.create({ data: { userId: reviewer, roleId: role.id } });
    } finally {
      await owner.$disconnect();
    }
  });

  afterAll(async () => {
    await app.$disconnect();
    await database.drop();
  });

  let sequence = 0;
  async function createUser(): Promise<string> {
    sequence += 1;
    const user = await app.user.create({
      data: {
        email: `repository${String(sequence)}@example.cd`,
        countryCode: 'CD',
        status: 'ACTIVE',
        termsAcceptedAt: now,
        emailVerifiedAt: now,
      },
      select: { id: true },
    });
    return user.id;
  }

  function identity(givenName = 'Jean'): KycDeclaration {
    return {
      level: 1,
      identity: {
        givenName,
        familyName: 'Mukendi',
        additionalName: 'Kabongo',
        dateOfBirth: new Date('1990-05-17T00:00:00.000Z'),
        placeOfBirth: 'Lubumbashi',
        nationality: 'CD',
        documentType: 'PASSPORT',
        documentNumberEncrypted: new Uint8Array(randomBytes(40)),
        documentNumberDigest: new Uint8Array(randomBytes(32)),
        documentIssuingCountry: 'CD',
        documentIssuedOn: new Date('2024-01-10T00:00:00.000Z'),
        documentIssuedAt: 'Kinshasa',
        documentExpiresOn: new Date(now.getTime() + 2000 * DAY_MS),
      },
    };
  }

  /** Dossier de niveau 1 en préparation, avec ses deux pièces obligatoires. */
  async function draft(createdAt: Date = now): Promise<string> {
    const caseId = await repository.createDraft(app, await createUser(), identity(), createdAt);
    for (const kind of ['IDENTITY_FRONT', 'SELFIE'] as const) {
      const id = randomUUID();
      await repository.insertDocument(
        app,
        {
          id,
          caseId,
          kind,
          contentType: 'image/jpeg',
          byteSize: 20_480,
          sha256: new Uint8Array(randomBytes(32)),
          storageKey: `${id.slice(-2)}/${id}`,
          wrappedKey: new Uint8Array(randomBytes(61)),
        },
        now,
      );
    }
    return caseId;
  }

  async function submitted(): Promise<string> {
    const caseId = await draft();
    expect(await repository.submit(app, caseId, now)).toBe(true);
    return caseId;
  }

  const approval = (decidedAt: Date) =>
    ({ status: 'APPROVED', decidedBy: reviewer, decidedAt, note: null }) as const;
  const rejection = (decidedAt: Date) =>
    ({
      status: 'REJECTED',
      decidedBy: reviewer,
      decidedAt,
      note: 'Pièce illisible, ticket 311',
      reasons: ['DOCUMENT_UNREADABLE'],
    }) as const;
  const revocation = (endedAt: Date) =>
    ({ revokedBy: reviewer, endedAt, reason: 'Pièce reconnue fausse' }) as const;

  const stored = (caseId: string) => app.kycCase.findUniqueOrThrow({ where: { id: caseId } });
  const documentsOf = (caseId: string) => app.kycDocument.count({ where: { caseId } });

  it('déposer ne s’applique qu’à un dossier en préparation, une seule fois', async () => {
    const caseId = await draft();

    expect(await repository.submit(app, caseId, now)).toBe(true);
    // Le second dépôt ne trouve plus rien à déposer : il le dit, sans erreur et sans écrire.
    expect(await repository.submit(app, caseId, later)).toBe(false);
    expect(await stored(caseId)).toMatchObject({
      status: 'SUBMITTED',
      submittedAt: now,
      updatedAt: now,
    });

    // Un dossier déjà décidé ne se dépose pas davantage.
    expect(await repository.decide(app, caseId, rejection(later))).toBe(true);
    expect(await repository.submit(app, caseId, later)).toBe(false);
    expect((await stored(caseId)).status).toBe('REJECTED');
  });

  it('un dossier déposé ne se remplace, ne se touche ni ne s’efface : rien n’est écrit', async () => {
    const caseId = await submitted();

    expect(await repository.updateDraft(app, caseId, identity('Paul'), later)).toBe(false);
    await repository.touchDraft(app, caseId, later);
    expect(await repository.deleteDraft(app, caseId)).toBeNull();

    expect(await stored(caseId)).toMatchObject({
      status: 'SUBMITTED',
      givenName: 'Jean',
      updatedAt: now,
    });
    // Ses pièces sont toujours là : l'effacement refusé n'en a retiré aucune.
    expect(await documentsOf(caseId)).toBe(2);
  });

  it('effacer un dossier en préparation retire ses pièces et rend l’emplacement de leurs fichiers', async () => {
    const caseId = await draft();
    const keys = (
      await app.kycDocument.findMany({ where: { caseId }, select: { storageKey: true } })
    ).map(({ storageKey }) => storageKey);

    const removed = await repository.deleteDraft(app, caseId);

    expect([...(removed ?? [])].sort()).toEqual([...keys].sort());
    expect(await app.kycCase.findUnique({ where: { id: caseId } })).toBeNull();
    expect(await documentsOf(caseId)).toBe(0);
    // Effacé, il n'y a plus rien à effacer.
    expect(await repository.deleteDraft(app, caseId)).toBeNull();
  });

  it('décider ne s’applique qu’à un dossier déposé, une seule fois', async () => {
    const inPreparation = await draft();
    expect(await repository.decide(app, inPreparation, approval(now))).toBe(false);
    expect((await stored(inPreparation)).status).toBe('DRAFT');

    const caseId = await submitted();
    expect(await repository.decide(app, caseId, approval(now))).toBe(true);
    // La décision contraire arrive trop tard : elle ne s'applique pas, et ne réécrit rien.
    expect(await repository.decide(app, caseId, rejection(later))).toBe(false);
    expect(await repository.decide(app, caseId, approval(later))).toBe(false);
    expect(await stored(caseId)).toMatchObject({
      status: 'APPROVED',
      decidedBy: reviewer,
      decidedAt: now,
      decisionNote: null,
      rejectionReasons: [],
      updatedAt: now,
    });
  });

  it('retirer ne s’applique qu’à un dossier accepté en vigueur, une seule fois', async () => {
    const waiting = await submitted();
    expect(await repository.revoke(app, waiting, revocation(now))).toBe(false);
    expect((await stored(waiting)).status).toBe('SUBMITTED');

    const caseId = await submitted();
    expect(await repository.decide(app, caseId, approval(now))).toBe(true);
    expect(await repository.revoke(app, caseId, revocation(later))).toBe(true);
    const again = new Date(later.getTime() + 60_000);
    expect(
      await repository.revoke(app, caseId, { ...revocation(again), reason: 'Autre motif' }),
    ).toBe(false);
    expect(await stored(caseId)).toMatchObject({
      status: 'REVOKED',
      revokedBy: reviewer,
      endedAt: later,
      revocationReason: 'Pièce reconnue fausse',
    });
  });

  it('la purge ne se voit proposer que des dossiers en préparation, les plus anciens d’abord', async () => {
    const daysAgo = (days: number): Date => new Date(now.getTime() - days * DAY_MS);
    const oldest = await draft(daysAgo(40));
    const older = await draft(daysAgo(35));
    await draft(daysAgo(10));
    // Un dossier déposé il y a longtemps — plus ancien que tous les autres — n'est pas un
    // dossier abandonné : il n'occupe jamais une place dans le lot à purger.
    const longSubmitted = await draft(daysAgo(60));
    expect(await repository.submit(app, longSubmitted, daysAgo(50))).toBe(true);

    expect(await repository.findStaleDrafts(app, daysAgo(30), 10)).toEqual([oldest, older]);
    expect(await repository.findStaleDrafts(app, daysAgo(30), 1)).toEqual([oldest]);
    // « Sans changement depuis » s'entend strictement : à l'instant même, pas encore.
    expect(await repository.findStaleDrafts(app, daysAgo(35), 10)).toEqual([oldest]);
    expect(await repository.findStaleDrafts(app, daysAgo(41), 10)).toEqual([]);
  });

  it('ce que la base refuse est une erreur nommée, pas un « rien à faire »', async () => {
    // Dossier sans pièces : la condition du dépôt est remplie, la base refuse le dépôt.
    const empty = await repository.createDraft(app, await createUser(), identity(), now);
    await expect(repository.submit(app, empty, now)).rejects.toBeInstanceOf(KycRuleViolationError);
    expect((await stored(empty)).status).toBe('DRAFT');

    // Décision par un compte sans qualité : la condition est remplie, la base refuse.
    const caseId = await submitted();
    const stranger = await createUser();
    await expect(
      repository.decide(app, caseId, { ...approval(now), decidedBy: stranger }),
    ).rejects.toBeInstanceOf(KycRuleViolationError);
    expect((await stored(caseId)).status).toBe('SUBMITTED');
  });
});
