import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import {
  type KycDeclaration,
  KycRuleViolationError,
} from '../../src/modules/kyc/application/kyc-case.repository.js';
import { PrismaAccountClosureRepository } from '../../src/modules/identity/infrastructure/prisma-account-closure.repository.js';
import { PrismaKycCaseRepository } from '../../src/modules/kyc/infrastructure/prisma-kyc-case.repository.js';
import { moveErasureTerm } from '../support/account-closure.js';
import {
  createTestDatabase,
  type TestDatabase,
  untilBlocked,
  withConnection,
} from '../support/test-database.js';

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
  async function draft(createdAt: Date = now, userId?: string): Promise<string> {
    const caseId = await repository.createDraft(
      app,
      userId ?? (await createUser()),
      identity(),
      createdAt,
    );
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

  async function submitted(userId?: string): Promise<string> {
    const caseId = await draft(now, userId);
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
  describe('clôture du compte et effacement', () => {
    const closures = new PrismaAccountClosureRepository();

    const filesOf = async (caseId: string): Promise<string[]> =>
      (await app.kycDocument.findMany({ where: { caseId }, select: { storageKey: true } }))
        .map(({ storageKey }) => storageKey)
        .sort();

    /** Compte portant un dossier dans chacun des états demandés ; rend leurs identifiants. */
    async function accountWith(kinds: readonly string[]): Promise<Record<string, string>> {
      const userId = await createUser();
      const cases: Record<string, string> = { userId };
      // Les dossiers clos d'abord : un seul dossier ouvert par compte et par niveau.
      if (kinds.includes('REJECTED')) {
        cases['REJECTED'] = await submitted(userId);
        expect(await repository.decide(app, cases['REJECTED'], rejection(now))).toBe(true);
      }
      if (kinds.includes('REVOKED')) {
        cases['REVOKED'] = await submitted(userId);
        expect(await repository.decide(app, cases['REVOKED'], approval(now))).toBe(true);
        expect(await repository.revoke(app, cases['REVOKED'], revocation(later))).toBe(true);
      }
      if (kinds.includes('APPROVED')) {
        cases['APPROVED'] = await submitted(userId);
        expect(await repository.decide(app, cases['APPROVED'], approval(now))).toBe(true);
      }
      if (kinds.includes('SUBMITTED')) {
        cases['SUBMITTED'] = await submitted(userId);
      } else if (kinds.includes('DRAFT')) {
        cases['DRAFT'] = await draft(now, userId);
      }
      return cases;
    }

    /**
     * Clôt le compte comme le fait le service — la trace et le compte, puis ses dossiers — dans
     * une seule transaction. @returns l'emplacement des fichiers effacés.
     */
    async function closeAccount(userId: string, retained: boolean): Promise<string[]> {
      const closedAt = new Date();
      const term = new Date(closedAt);
      term.setUTCFullYear(term.getUTCFullYear() + 10);
      return app.$transaction(async (tx) => {
        await repository.lockCasesOf(tx, userId);
        const account = await closures.lockAccount(tx, userId);
        await closures.close(tx, {
          userId,
          closedAt,
          origin: 'HOLDER',
          closedBy: userId,
          email: account!.email,
          phone: account!.phone,
          legalRetentionUntil: retained ? term : null,
          erasureDueAt: retained ? term : new Date(closedAt.getTime() + 30 * DAY_MS),
        });
        return repository.closeForAccount(tx, userId, closedAt);
      });
    }

    it('dit si un dossier attend l’examen, et si une décision a été prise — pour ce compte seulement', async () => {
      const expectations: readonly (readonly [readonly string[], boolean, boolean])[] = [
        [[], false, false],
        [['DRAFT'], false, false],
        [['SUBMITTED'], true, false],
        [['APPROVED'], false, true],
        [['REJECTED'], false, true],
        [['REVOKED'], false, true],
        [['REJECTED', 'SUBMITTED'], true, true],
        [['APPROVED', 'DRAFT'], false, true],
      ];
      for (const [kinds, awaiting, decided] of expectations) {
        const { userId } = await accountWith(kinds);
        expect({
          kinds,
          awaiting: await repository.hasCaseAwaitingReview(app, userId!),
          decided: await repository.hasDecidedCase(app, userId!),
        }).toEqual({ kinds, awaiting, decided });
      }
    });

    it('verrouiller tient tous les dossiers du compte : un dépôt en cours attend', async () => {
      const { userId, DRAFT: caseId } = await accountWith(['DRAFT']);
      const stranger = await draft();

      await withConnection(database.appUrl, async (writer) => {
        await withConnection(database.appUrl, async (observer) => {
          let submission: Promise<unknown> | undefined;
          await app.$transaction(async (tx) => {
            await repository.lockCasesOf(tx, userId!);
            // Le dossier d'un autre compte n'est pas tenu.
            await writer.query(`UPDATE kyc_cases SET updated_at = now() WHERE id = $1`, [stranger]);
            submission = writer.query(
              `UPDATE kyc_cases SET status = 'SUBMITTED', submitted_at = now(), updated_at = now()
               WHERE id = $1`,
              [caseId],
            );
            await untilBlocked(observer);
          });
          await submission;
        });
      });
      expect((await stored(caseId!)).status).toBe('SUBMITTED');
    });

    it('la clôture met fin à la vérification en vigueur, efface ce qui n’a jamais été examiné et rend ses fichiers', async () => {
      const cases = await accountWith(['REJECTED', 'REVOKED', 'APPROVED', 'SUBMITTED']);
      const pendingFiles = await filesOf(cases['SUBMITTED']!);
      const other = await accountWith(['APPROVED', 'DRAFT']);
      const draftFiles = await filesOf(other['DRAFT']!);

      const removed = await closeAccount(cases['userId']!, true);

      expect([...removed].sort()).toEqual(pendingFiles);
      expect(await app.kycCase.findUnique({ where: { id: cases['SUBMITTED']! } })).toBeNull();
      expect(await documentsOf(cases['SUBMITTED']!)).toBe(0);
      const ended = await stored(cases['APPROVED']!);
      expect(ended).toMatchObject({
        status: 'ACCOUNT_CLOSED',
        revokedBy: null,
        decidedBy: reviewer,
      });
      expect(ended.endedAt).toEqual(ended.updatedAt);
      expect(ended.endedAt).not.toBeNull();
      // Les dossiers déjà clos gardent leur statut, leurs dates et leurs pièces.
      expect(await stored(cases['REJECTED']!)).toMatchObject({ status: 'REJECTED', endedAt: null });
      expect(await stored(cases['REVOKED']!)).toMatchObject({ status: 'REVOKED', endedAt: later });
      for (const kind of ['APPROVED', 'REJECTED', 'REVOKED']) {
        expect(await documentsOf(cases[kind]!)).toBe(2);
      }
      expect(await repository.hasCaseAwaitingReview(app, cases['userId']!)).toBe(false);

      // Un dossier en préparation s'efface de même, avec ses pièces.
      expect([...(await closeAccount(other['userId']!, true))].sort()).toEqual(draftFiles);
      expect((await stored(other['APPROVED']!)).status).toBe('ACCOUNT_CLOSED');
      // Les dossiers des autres comptes n'ont pas bougé.
      expect((await stored(await submitted())).status).toBe('SUBMITTED');
    });

    it('sur un compte ouvert, la base refuse : erreur nommée, et rien n’est écrit', async () => {
      const cases = await accountWith(['APPROVED', 'SUBMITTED']);
      const userId = cases['userId']!;

      await expect(
        app.$transaction((tx) => repository.closeForAccount(tx, userId, later)),
      ).rejects.toBeInstanceOf(KycRuleViolationError);
      await expect(
        app.$transaction((tx) => repository.eraseAllOf(tx, userId)),
      ).rejects.toBeInstanceOf(KycRuleViolationError);

      expect((await stored(cases['APPROVED']!)).status).toBe('APPROVED');
      expect((await stored(cases['SUBMITTED']!)).status).toBe('SUBMITTED');
      expect(await documentsOf(cases['APPROVED']!)).toBe(2);
      expect(await documentsOf(cases['SUBMITTED']!)).toBe(2);
    });

    it('tout effacer : refusé avant le terme de la conservation ; au terme, rend l’emplacement de tous les fichiers', async () => {
      const cases = await accountWith(['REJECTED', 'APPROVED']);
      const userId = cases['userId']!;
      const files = [
        ...(await filesOf(cases['REJECTED']!)),
        ...(await filesOf(cases['APPROVED']!)),
      ];
      expect(await closeAccount(userId, true)).toEqual([]);
      expect([...(await repository.documentFilesOf(app, userId))].sort()).toEqual(
        [...files].sort(),
      );

      // Avant le terme, lu à l'horloge de la base : rien ne s'efface, pas même une pièce.
      await expect(
        app.$transaction((tx) => repository.eraseAllOf(tx, userId)),
      ).rejects.toBeInstanceOf(KycRuleViolationError);
      expect(await app.kycCase.count({ where: { userId } })).toBe(2);
      expect(await app.kycDocument.count({ where: { case: { userId } } })).toBe(4);

      await withConnection(database.ownerUrl, (owner) => moveErasureTerm(owner, userId, '-1 day'));
      const erased = await app.$transaction((tx) => repository.eraseAllOf(tx, userId));
      expect([...erased].sort()).toEqual([...files].sort());
      expect(await app.kycCase.count({ where: { userId } })).toBe(0);
      expect(await app.kycDocument.count({ where: { case: { userId } } })).toBe(0);
      expect(await repository.documentFilesOf(app, userId)).toEqual([]);
      // Effacé, il n'y a plus rien à effacer.
      expect(await app.$transaction((tx) => repository.eraseAllOf(tx, userId))).toEqual([]);
    });

    it('rend tous les dossiers d’un compte, du plus récent au plus ancien — et eux seuls', async () => {
      const cases = await accountWith(['REJECTED', 'APPROVED', 'DRAFT']);
      await accountWith(['SUBMITTED']);

      const all = await repository.allCasesOf(app, cases['userId']!);

      expect(all.map(({ id }) => id)).toEqual([
        cases['DRAFT'],
        cases['APPROVED'],
        cases['REJECTED'],
      ]);
      expect(all.map(({ status }) => status)).toEqual(['DRAFT', 'APPROVED', 'REJECTED']);
      expect(all.every(({ userId }) => userId === cases['userId'])).toBe(true);
      expect(all[0]?.documents).toHaveLength(2);
      expect(await repository.allCasesOf(app, await createUser())).toEqual([]);
    });
  });
});
