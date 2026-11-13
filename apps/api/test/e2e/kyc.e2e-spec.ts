import { rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, connect } from 'node:net';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  activityListSchema,
  adminKycCaseListSchema,
  adminKycCaseSchema,
  adminUserDetailSchema,
  currentUserSchema,
  dataExportSchema,
  KYC_DOCUMENT_MAX_BYTES,
  type KycCase,
  kycCaseSchema,
  kycOverviewSchema,
  problemDetailsSchema,
  profileSchema,
} from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { AccountMaintenanceService } from '../../src/modules/identity/application/account-maintenance.service.js';
import { KycUploadSlots } from '../../src/modules/kyc/application/kyc-upload-slots.js';
import { KYC_UPLOADS_IN_FLIGHT_MAX } from '../../src/modules/kyc/domain/kyc-policy.js';
import { SystemSettingsService } from '../../src/modules/system-settings/application/system-settings.service.js';
import {
  backgroundWorkDone,
  bearer,
  createAdmin,
  enableSecondFactor,
  from,
  type Http,
  login,
  mailbox,
  newClientIp,
  newEmail,
  nextMessageOf,
  openFeature,
  type RegisteredUser,
  registerVerifiedUser,
  withOwner,
} from '../support/identity.js';
import {
  addressDeclaration,
  createKycStorage,
  dayFromNow,
  fundsDeclaration,
  identityDeclaration,
  jpeg,
  type KycTestStorage,
  newDocumentNumber,
  pdf,
  png,
  type TestFile,
} from '../support/kyc.js';
import { addDocument, insertCase } from '../support/kyc-sql.js';
import { createTestApp, eventually, type TestApp, testClock } from '../support/test-app.js';
import { withConnection } from '../support/test-database.js';

const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const NOTE = 'Photo de la pièce illisible, voir ticket conformité 2026-0311';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Member extends RegisteredUser {
  readonly id: string;
  readonly accessToken: string;
}

describe('Vérification d’identité (KYC) — bout en bout', () => {
  let storage: KycTestStorage;
  let testApp: TestApp;
  let http: Http;
  let prisma: PrismaService;
  /** Agents de conformité partagés par les tests. */
  let claire: Member;
  let david: Member;

  const get = (accessToken: string, path: string) =>
    http.get(`/api/v1${path}`).set(bearer(accessToken)).set(from(newClientIp()));
  const post = (accessToken: string, path: string, body?: Record<string, unknown>) =>
    http.post(`/api/v1${path}`).set(bearer(accessToken)).set(from(newClientIp())).send(body);
  const put = (accessToken: string, path: string, body: Record<string, unknown>) =>
    http.put(`/api/v1${path}`).set(bearer(accessToken)).set(from(newClientIp())).send(body);
  const del = (accessToken: string, path: string) =>
    http.delete(`/api/v1${path}`).set(bearer(accessToken)).set(from(newClientIp()));
  const codeOf = (response: { body: unknown }) => problemDetailsSchema.parse(response.body).code;
  /** Champs en erreur, sans doublon : un champ peut enfreindre plusieurs règles à la fois. */
  const errorPaths = (response: { body: unknown }) =>
    [
      ...new Set((problemDetailsSchema.parse(response.body).errors ?? []).map(({ path }) => path)),
    ].sort();

  /** Envoie un fichier comme le fait un client : le fichier lui-même, avec son type. */
  const upload = (member: Member, caseId: string, kind: string, file: TestFile) =>
    http
      .post(`/api/v1/me/verification/cases/${caseId}/documents?kind=${kind}`)
      .set(bearer(member.accessToken))
      .set(from(newClientIp()))
      .set('Content-Type', file.contentType)
      .send(file.content);

  /** Utilisateur final connecté. */
  async function customer(): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp);
    const session = await login(http, user);
    return { ...user, id: session.user.id, accessToken: session.tokens.accessToken };
  }

  /** Attribue un rôle comme le ferait une migration (rôle propriétaire) : préparation de test. */
  async function grantAsOwner(userId: string, roleKey: string): Promise<void> {
    await withOwner(testApp, async (owner) => {
      const role = await owner.role.findUniqueOrThrow({ where: { key: roleKey } });
      await owner.userRole.create({ data: { userId, roleId: role.id } });
    });
  }

  /** Membre du personnel : un rôle, le second facteur activé, connecté. */
  async function staff(roleKey: string): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp, { email: newEmail(roleKey) });
    const first = await login(http, user);
    await grantAsOwner(first.user.id, roleKey);
    const totpSecret = await enableSecondFactor(testApp, {
      id: first.user.id,
      password: user.password,
    });
    const session = await login(http, { ...user, totpSecret });
    return { ...user, totpSecret, id: first.user.id, accessToken: session.tokens.accessToken };
  }

  const caseOf = (response: { body: unknown }): KycCase => kycCaseSchema.parse(response.body);
  const adminCaseOf = (response: { body: unknown }) => adminKycCaseSchema.parse(response.body);
  const overviewOf = async (member: Member) =>
    kycOverviewSchema.parse((await get(member.accessToken, '/me/verification').expect(200)).body);
  const levelOf = async (member: Member) =>
    currentUserSchema.parse((await get(member.accessToken, '/me').expect(200)).body)
      .verificationLevel;
  const fetchCase = async (member: Member, caseId: string) =>
    caseOf(await get(member.accessToken, `/me/verification/cases/${caseId}`).expect(200));

  /** Dossier de niveau 1 en préparation, avec ses deux pièces obligatoires (passeport). */
  async function identityDraft(
    member: Member,
    overrides: Parameters<typeof identityDeclaration>[0] = {},
  ): Promise<KycCase> {
    const draft = caseOf(
      await put(
        member.accessToken,
        '/me/verification/identity',
        identityDeclaration(overrides),
      ).expect(200),
    );
    await upload(member, draft.id, 'IDENTITY_FRONT', jpeg(`front:${draft.id}`)).expect(201);
    return caseOf(await upload(member, draft.id, 'SELFIE', png(`selfie:${draft.id}`)).expect(201));
  }

  const submit = async (member: Member, caseId: string) =>
    caseOf(await post(member.accessToken, `/me/verification/cases/${caseId}/submit`).expect(200));
  const approve = async (reviewer: Member, caseId: string) =>
    adminCaseOf(await post(reviewer.accessToken, `/admin/kyc/cases/${caseId}/approve`).expect(200));
  const reject = async (reviewer: Member, caseId: string) =>
    adminCaseOf(
      await post(reviewer.accessToken, `/admin/kyc/cases/${caseId}/reject`, {
        reasons: ['DOCUMENT_UNREADABLE'],
        note: NOTE,
      }).expect(200),
    );

  /** Dossier de niveau 1 déposé. */
  async function submittedIdentity(
    member: Member,
    overrides: Parameters<typeof identityDeclaration>[0] = {},
  ): Promise<KycCase> {
    return submit(member, (await identityDraft(member, overrides)).id);
  }

  /** Dossier de niveau 2 déposé (le niveau 1 doit être vérifié). */
  async function submittedAddress(member: Member): Promise<KycCase> {
    const draft = caseOf(
      await put(member.accessToken, '/me/verification/address', addressDeclaration()).expect(200),
    );
    await upload(member, draft.id, 'PROOF_OF_ADDRESS', pdf(`proof:${draft.id}`)).expect(201);
    return submit(member, draft.id);
  }

  /** Dossier de niveau 3 déposé (le niveau 2 doit être vérifié). */
  async function submittedFunds(member: Member): Promise<KycCase> {
    const draft = caseOf(
      await put(member.accessToken, '/me/verification/source-of-funds', fundsDeclaration()).expect(
        200,
      ),
    );
    await upload(member, draft.id, 'SOURCE_OF_FUNDS', pdf(`funds:${draft.id}`)).expect(201);
    return submit(member, draft.id);
  }

  /** Utilisateur final dont les niveaux 1 à `level` sont vérifiés. */
  async function verifiedCustomer(level: 1 | 2 | 3): Promise<Member> {
    const member = await customer();
    await approve(claire, (await submittedIdentity(member)).id);
    if (level >= 2) {
      await approve(claire, (await submittedAddress(member)).id);
    }
    if (level >= 3) {
      await approve(claire, (await submittedFunds(member)).id);
    }
    return member;
  }

  const auditEntries = (action: string, resourceId?: string) =>
    prisma.auditLog.findMany({
      where: { action, ...(resourceId === undefined ? {} : { resourceId }) },
      orderBy: { id: 'asc' },
    });

  const activityTypes = async (member: Member) =>
    activityListSchema
      .parse((await get(member.accessToken, '/me/activity?limit=100').expect(200)).body)
      .entries.map((entry) => entry.type);

  /** Fichiers du stockage qui correspondent aux pièces d'un dossier. */
  const storedFilesOf = async (caseId: string) =>
    (await prisma.kycDocument.findMany({ where: { caseId }, select: { storageKey: true } }))
      .map(({ storageKey }) => storageKey)
      .sort();

  /** Port d'écoute de l'application, pour les échanges faits à la main sur une connexion. */
  async function listeningPort(): Promise<number> {
    const server = testApp.app.getHttpServer();
    if (!server.listening) {
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    return (server.address() as AddressInfo).port;
  }

  /**
   * Écrit une requête telle quelle sur une connexion et retourne ce que le serveur répond,
   * jusqu'à ce qu'il ferme la connexion — ou que le client raccroche : après un délai
   * (`hangUpAfterMs`), ou dès que le serveur a répondu (`hangUpOnceAnswered`).
   */
  function rawExchange(
    port: number,
    head: string,
    body: Buffer,
    options: { hangUpAfterMs?: number; hangUpOnceAnswered?: boolean } = {},
  ): Promise<{ response: string; closedByServer: boolean }> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      const chunks: Buffer[] = [];
      let hungUp = false;
      let quiet: NodeJS.Timeout | undefined;
      const hangUp = (): void => {
        hungUp = true;
        socket.destroy();
      };
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('The server neither answered nor closed the connection.'));
      }, 8000);
      socket.on('connect', () => {
        socket.write(head);
        socket.write(body);
        if (options.hangUpAfterMs !== undefined) {
          setTimeout(hangUp, options.hangUpAfterMs);
        }
      });
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (options.hangUpOnceAnswered === true) {
          // La réponse peut arriver en plusieurs écritures : on attend qu'elle se taise.
          clearTimeout(quiet);
          quiet = setTimeout(hangUp, 100);
        }
      });
      socket.on('error', () => undefined);
      socket.on('close', () => {
        clearTimeout(timer);
        resolve({ response: Buffer.concat(chunks).toString('latin1'), closedByServer: !hungUp });
      });
    });
  }

  beforeAll(async () => {
    storage = createKycStorage();
    testApp = await createTestApp({
      env: { TRUST_PROXY_HOPS: '1', ...storage.env },
    });
    http = request(testApp.app.getHttpServer());
    prisma = testApp.app.get(PrismaService);
    await openFeature(testApp, 'registration');
    await openFeature(testApp, 'kyc');
    claire = await staff('compliance');
    david = await staff('compliance');
  });

  afterAll(async () => {
    await testApp.close();
    storage.remove();
  });

  describe('ouverture de la fonctionnalité', () => {
    it('tant qu’elle est fermée, les routes du titulaire répondent FEATURE_DISABLED', async () => {
      const member = await customer();
      const settings = testApp.app.get(SystemSettingsService);
      const context = { actor: { type: 'SYSTEM' } as const, reason: 'test: kyc closed' };
      const casesBefore = await prisma.kycCase.count();
      const filesBefore = storage.files();

      // C'est l'état par défaut d'une plateforme neuve.
      await settings.setFeatureEnabled('kyc', false, context);
      try {
        for (const response of [
          await get(member.accessToken, '/me/verification'),
          await put(member.accessToken, '/me/verification/identity', identityDeclaration()),
          await put(member.accessToken, '/me/verification/address', addressDeclaration()),
          await put(member.accessToken, '/me/verification/source-of-funds', fundsDeclaration()),
          await get(member.accessToken, `/me/verification/cases/${UNKNOWN_ID}`),
          await upload(member, UNKNOWN_ID, 'SELFIE', jpeg('closed')),
          await del(
            member.accessToken,
            `/me/verification/cases/${UNKNOWN_ID}/documents/${UNKNOWN_ID}`,
          ),
          await post(member.accessToken, `/me/verification/cases/${UNKNOWN_ID}/submit`),
          await del(member.accessToken, `/me/verification/cases/${UNKNOWN_ID}`),
        ]) {
          expect(response.status).toBe(403);
          expect(codeOf(response)).toBe('FEATURE_DISABLED');
        }
        expect(await prisma.kycCase.count()).toBe(casesBefore);
        expect(storage.files()).toEqual(filesBefore);

        // Le niveau de vérification reste lisible : il vaut zéro.
        expect(await levelOf(member)).toBe(0);
      } finally {
        await settings.setFeatureEnabled('kyc', true, context);
      }
      await get(member.accessToken, '/me/verification').expect(200);
    });

    it('une requête sans session est refusée avant tout', async () => {
      await http.get('/api/v1/me/verification').expect(401);
      await http
        .post(`/api/v1/me/verification/cases/${UNKNOWN_ID}/documents?kind=SELFIE`)
        .set('Content-Type', 'image/jpeg')
        .send(jpeg('anonymous').content)
        .expect(401);
      await http.get('/api/v1/admin/kyc/cases').expect(401);
      expect(storage.files()).toEqual([]);
    });
  });

  describe('préparer un dossier d’identité (niveau 1)', () => {
    it('un nouveau compte part du niveau 0 : seul le niveau 1 lui est ouvert', async () => {
      const member = await customer();

      const overview = await overviewOf(member);
      expect(overview).toEqual({
        level: 0,
        levels: [
          { level: 1, verified: false, verifiedAt: null, available: true, currentCase: null },
          { level: 2, verified: false, verifiedAt: null, available: false, currentCase: null },
          { level: 3, verified: false, verifiedAt: null, available: false, currentCase: null },
        ],
      });
      expect(await levelOf(member)).toBe(0);
    });

    it('enregistrer crée le dossier, puis le remplace ; le numéro de la pièce n’est jamais rendu ni stocké en clair', async () => {
      const member = await customer();
      const number = newDocumentNumber();

      const created = caseOf(
        await put(
          member.accessToken,
          '/me/verification/identity',
          identityDeclaration({
            document: { number: ` ${number.slice(0, 2)}-${number.slice(2)} ` },
          }),
        ).expect(200),
      );
      expect(created).toMatchObject({
        level: 1,
        status: 'DRAFT',
        submittedAt: null,
        decidedAt: null,
        rejectionReasons: [],
        address: null,
        sourceOfFunds: null,
        documents: [],
        // Un passeport n'a qu'une face.
        missingDocuments: ['IDENTITY_FRONT', 'SELFIE'],
        identity: {
          givenName: 'Jean',
          familyName: 'Mukendi',
          additionalName: 'Kabongo',
          dateOfBirth: '1990-05-17',
          placeOfBirth: 'Lubumbashi',
          nationality: 'CD',
          document: { type: 'PASSPORT', issuingCountry: 'CD', issuedAt: 'Kinshasa' },
        },
      });
      // Seuls les trois derniers caractères restent lisibles.
      expect(created.identity?.document.numberMasked).toBe(`••••${number.slice(-3)}`);
      expect(JSON.stringify(created)).not.toContain(number);

      // En base : chiffré, et rien qui permette de le lire.
      const row = await prisma.kycCase.findUniqueOrThrow({ where: { id: created.id } });
      const encrypted = Buffer.from(row.documentNumberEncrypted ?? []);
      expect(encrypted.length).toBeGreaterThan(number.length + 28);
      expect(encrypted.includes(Buffer.from(number))).toBe(false);
      expect(Buffer.from(row.documentNumberDigest ?? []).length).toBe(32);

      // Au journal : le fait, jamais le contenu.
      const [saved] = await auditEntries('kyc_case.draft_saved', created.id);
      expect(saved).toMatchObject({ actorId: member.id, outcome: 'SUCCESS' });
      expect(saved?.metadata).toEqual({ level: 1, created: true });

      // Un second enregistrement remplace la déclaration du même dossier.
      testClock.advance(1000);
      const replaced = caseOf(
        await put(
          member.accessToken,
          '/me/verification/identity',
          identityDeclaration({
            givenName: 'Jeanne',
            additionalName: null,
            document: { type: 'NATIONAL_ID_CARD', number, expiresOn: null },
          }),
        ).expect(200),
      );
      expect(replaced.id).toBe(created.id);
      expect(replaced.identity).toMatchObject({
        givenName: 'Jeanne',
        additionalName: null,
        document: { type: 'NATIONAL_ID_CARD', expiresOn: null },
      });
      // Une carte d'identité a deux faces : le verso devient obligatoire.
      expect(replaced.missingDocuments).toEqual(['IDENTITY_FRONT', 'IDENTITY_BACK', 'SELFIE']);
      expect(Date.parse(replaced.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
      expect(await prisma.kycCase.count({ where: { userId: member.id } })).toBe(1);

      const overview = await overviewOf(member);
      expect(overview.levels[0]).toMatchObject({
        available: true,
        currentCase: { id: created.id, status: 'DRAFT' },
      });
    });

    it('refuse une déclaration invalide, champ par champ', async () => {
      const member = await customer();
      const save = (overrides: Parameters<typeof identityDeclaration>[0]) =>
        put(member.accessToken, '/me/verification/identity', identityDeclaration(overrides));

      const minor = await save({ dateOfBirth: dayFromNow(-17 * 365) }).expect(400);
      expect(codeOf(minor)).toBe('VALIDATION_FAILED');
      expect(errorPaths(minor)).toEqual(['dateOfBirth']);

      const expired = await save({ document: { expiresOn: dayFromNow(-1) } }).expect(400);
      expect(errorPaths(expired)).toEqual(['document.expiresOn']);
      // Une pièce qui expire aujourd'hui n'est déjà plus valable.
      expect(
        errorPaths(await save({ document: { expiresOn: dayFromNow(0) } }).expect(400)),
      ).toEqual(['document.expiresOn']);

      const passportWithoutExpiry = await save({ document: { expiresOn: null } }).expect(400);
      expect(errorPaths(passportWithoutExpiry)).toEqual(['document.expiresOn']);

      const foreignVoterCard = await save({
        document: { type: 'VOTER_CARD', issuingCountry: 'CG', expiresOn: null },
      }).expect(400);
      expect(errorPaths(foreignVoterCard)).toEqual(['document.issuingCountry']);

      const issuedTomorrow = await save({ document: { issuedOn: dayFromNow(1) } }).expect(400);
      expect(errorPaths(issuedTomorrow)).toEqual(['document.issuedOn']);

      const issuedBeforeBirth = await save({ document: { issuedOn: '1989-01-01' } }).expect(400);
      expect(errorPaths(issuedBeforeBirth)).toEqual(['document.issuedOn']);

      const malformed = await put(member.accessToken, '/me/verification/identity', {
        ...identityDeclaration(),
        givenName: '   ',
        nationality: 'Congo',
        unexpected: true,
      }).expect(400);
      expect(errorPaths(malformed)).toEqual(['', 'givenName', 'nationality']);

      const badNumber = await save({ document: { number: 'AB' } }).expect(400);
      expect(errorPaths(badNumber)).toEqual(['document.number']);

      expect(await prisma.kycCase.count({ where: { userId: member.id } })).toBe(0);
    });

    it('un compte d’entreprise ne peut pas encore être vérifié', async () => {
      const member = await customer();
      await withOwner(testApp, (owner) =>
        owner.user.update({ where: { id: member.id }, data: { accountType: 'BUSINESS' } }),
      );

      const refused = await put(
        member.accessToken,
        '/me/verification/identity',
        identityDeclaration(),
      ).expect(422);
      expect(codeOf(refused)).toBe('UNPROCESSABLE_ENTITY');
      expect(refused.body.detail).toMatch(/business accounts/);

      const overview = await overviewOf(member);
      expect(overview.levels.map(({ available }) => available)).toEqual([false, false, false]);
    });
  });

  describe('joindre des pièces', () => {
    it('la pièce est vérifiée, chiffrée puis écrite : le stockage ne contient rien de lisible', async () => {
      const member = await customer();
      const draft = caseOf(
        await put(member.accessToken, '/me/verification/identity', identityDeclaration()).expect(
          200,
        ),
      );
      const front = jpeg('recto du passeport', 150_000);

      const withFront = caseOf(await upload(member, draft.id, 'IDENTITY_FRONT', front).expect(201));
      expect(withFront.documents).toHaveLength(1);
      expect(withFront.documents[0]).toMatchObject({
        kind: 'IDENTITY_FRONT',
        contentType: 'image/jpeg',
        byteSize: 150_000,
      });
      expect(withFront.missingDocuments).toEqual(['SELFIE']);

      const document = await prisma.kycDocument.findFirstOrThrow({ where: { caseId: draft.id } });
      // Rangée d'après la fin de son identifiant.
      expect(document.storageKey).toBe(`${document.id.slice(-2)}/${document.id}`);
      expect(storage.files()).toContain(document.storageKey);

      const stored = storage.read(document.storageKey);
      // Version (1) + nonce (12) + contenu + étiquette d'authenticité (16).
      expect(stored.length).toBe(front.content.length + 29);
      expect(stored.subarray(0, 3).equals(front.content.subarray(0, 3))).toBe(false);
      // Aucun fragment du fichier d'origine ne se retrouve sur le disque.
      for (const offset of [0, 1024, 75_000, 149_000]) {
        expect(stored.includes(front.content.subarray(offset, offset + 32))).toBe(false);
      }
      // La clé du fichier, elle-même chiffrée, n'est qu'en base.
      expect(Buffer.from(document.wrappedKey).length).toBe(1 + 12 + 32 + 16);

      const [added] = await auditEntries('kyc_case.document_added', draft.id);
      expect(added?.metadata).toEqual({
        documentId: document.id,
        kind: 'IDENTITY_FRONT',
        contentType: 'image/jpeg',
        byteSize: 150_000,
        replaced: 0,
      });
    });

    it('renvoyer une pièce unique la remplace : l’ancien fichier est effacé', async () => {
      const member = await customer();
      const draft = await identityDraft(member);
      const [before] = await storedFilesOf(draft.id);
      const frontBefore = draft.documents.find(({ kind }) => kind === 'IDENTITY_FRONT');

      const after = caseOf(
        await upload(member, draft.id, 'IDENTITY_FRONT', pdf('nouveau recto')).expect(201),
      );

      expect(after.documents.map(({ kind }) => kind).sort()).toEqual(['IDENTITY_FRONT', 'SELFIE']);
      const frontAfter = after.documents.find(({ kind }) => kind === 'IDENTITY_FRONT');
      expect(frontAfter?.id).not.toBe(frontBefore?.id);
      expect(frontAfter?.contentType).toBe('application/pdf');

      const files = await storedFilesOf(draft.id);
      expect(files).toHaveLength(2);
      expect(storage.files()).toEqual(expect.arrayContaining(files));
      expect(storage.files()).not.toContain(
        `${frontBefore?.id.slice(-2) ?? ''}/${frontBefore?.id ?? ''}`,
      );
      expect(before).toBeDefined();
    });

    it('refuse ce qui n’est pas une pièce recevable, sans rien conserver', async () => {
      const member = await customer();
      const draft = caseOf(
        await put(member.accessToken, '/me/verification/identity', identityDeclaration()).expect(
          200,
        ),
      );
      const filesBefore = storage.files();
      const send = (kind: string, contentType: string, content: Buffer | string) =>
        http
          .post(`/api/v1/me/verification/cases/${draft.id}/documents?kind=${kind}`)
          .set(bearer(member.accessToken))
          .set(from(newClientIp()))
          .set('Content-Type', contentType)
          .send(content);

      // Type annoncé non accepté : rien n'est lu.
      for (const type of ['text/plain', 'image/gif', 'application/octet-stream', 'image/svg+xml']) {
        const refused = await send('IDENTITY_FRONT', type, jpeg('x').content).expect(415);
        expect(codeOf(refused)).toBe('UNSUPPORTED_MEDIA_TYPE');
      }
      // Un formulaire ou du JSON ne sont pas un fichier.
      await http
        .post(`/api/v1/me/verification/cases/${draft.id}/documents?kind=IDENTITY_FRONT`)
        .set(bearer(member.accessToken))
        .attach('file', jpeg('form').content, 'front.jpg')
        .expect(415);
      await post(member.accessToken, `/me/verification/cases/${draft.id}/documents?kind=SELFIE`, {
        file: 'base64…',
      }).expect(415);

      // Le contenu ne correspond pas au type annoncé.
      const disguised = await send('IDENTITY_FRONT', 'image/jpeg', pdf('disguised').content).expect(
        415,
      );
      expect(disguised.body.detail).toMatch(/does not match its declared type/);
      await send('IDENTITY_FRONT', 'image/png', Buffer.alloc(4096, 0x41)).expect(415);
      await send(
        'IDENTITY_FRONT',
        'application/pdf',
        Buffer.from(`<html><script>alert(1)</script>${'x'.repeat(2000)}</html>`),
      ).expect(415);

      // Un autoportrait est une image.
      const pdfSelfie = await send('SELFIE', 'application/pdf', pdf('selfie').content).expect(415);
      expect(pdfSelfie.body.detail).toMatch(/selfie must be a JPEG or PNG image/);

      // Trop petit pour être une pièce ; corps vide.
      expect(codeOf(await upload(member, draft.id, 'SELFIE', jpeg('tiny', 1023)).expect(422))).toBe(
        'UNPROCESSABLE_ENTITY',
      );
      await send('SELFIE', 'image/jpeg', '').expect(422);

      // Nature inconnue, ou étrangère à ce niveau.
      expect(errorPaths(await upload(member, draft.id, 'PASSPORT', jpeg('k')).expect(400))).toEqual(
        ['kind'],
      );
      await http
        .post(`/api/v1/me/verification/cases/${draft.id}/documents`)
        .set(bearer(member.accessToken))
        .set('Content-Type', 'image/jpeg')
        .send(jpeg('no kind').content)
        .expect(400);
      const wrongLevel = await upload(member, draft.id, 'PROOF_OF_ADDRESS', pdf('p')).expect(422);
      expect(wrongLevel.body.detail).toMatch(/does not belong to a level 1 case/);

      // Dossier inconnu ou identifiant malformé.
      await upload(member, UNKNOWN_ID, 'SELFIE', jpeg('unknown')).expect(404);
      await upload(member, 'not-a-uuid', 'SELFIE', jpeg('malformed')).expect(400);

      expect(await prisma.kycDocument.count({ where: { caseId: draft.id } })).toBe(0);
      expect(storage.files()).toEqual(filesBefore);
    });

    it('accepte exactement la taille maximale et refuse un octet de plus', async () => {
      const member = await customer();
      const draft = caseOf(
        await put(member.accessToken, '/me/verification/identity', identityDeclaration()).expect(
          200,
        ),
      );
      const filesBefore = storage.files().length;

      const tooLarge = await upload(
        member,
        draft.id,
        'IDENTITY_FRONT',
        jpeg('un octet de trop', KYC_DOCUMENT_MAX_BYTES + 1),
      ).expect(413);
      expect(codeOf(tooLarge)).toBe('PAYLOAD_TOO_LARGE');
      expect(await prisma.kycDocument.count({ where: { caseId: draft.id } })).toBe(0);
      expect(storage.files()).toHaveLength(filesBefore);

      const atLimit = caseOf(
        await upload(
          member,
          draft.id,
          'IDENTITY_FRONT',
          jpeg('exactement la limite', KYC_DOCUMENT_MAX_BYTES),
        ).expect(201),
      );
      expect(atLimit.documents[0]?.byteSize).toBe(KYC_DOCUMENT_MAX_BYTES);
      expect(storage.files()).toHaveLength(filesBefore + 1);
    });

    it('un envoi annoncé démesuré est refusé sans être lu, et la connexion est fermée', async () => {
      const member = await customer();
      const draft = caseOf(
        await put(member.accessToken, '/me/verification/identity', identityDeclaration()).expect(
          200,
        ),
      );
      const filesBefore = storage.files();
      const port = await listeningPort();
      const head = [
        `POST /api/v1/me/verification/cases/${draft.id}/documents?kind=SELFIE HTTP/1.1`,
        'Host: localhost',
        `Authorization: Bearer ${member.accessToken}`,
        `X-Forwarded-For: ${newClientIp()}`,
        'Content-Type: image/jpeg',
      ];

      // 50 Mo annoncés, dont seuls les premiers octets sont envoyés : la réponse n'attend pas.
      const startedAt = Date.now();
      const oversized = await rawExchange(
        port,
        [...head, 'Content-Length: 50000000', '', ''].join('\r\n'),
        jpeg('début d’un envoi démesuré', 4096).content,
      );
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(oversized.closedByServer).toBe(true);
      expect(oversized.response).toMatch(/^HTTP\/1\.1 413 /);
      expect(oversized.response).toMatch(/\r\nConnection: close\r\n/i);
      expect(oversized.response).toMatch(/\r\nContent-Type: application\/problem\+json/i);
      expect(oversized.response).toContain('"code":"PAYLOAD_TOO_LARGE"');

      // Un envoi interrompu en cours de route ne laisse rien derrière lui.
      const interrupted = await rawExchange(
        port,
        [...head, 'Content-Length: 200000', '', ''].join('\r\n'),
        jpeg('envoi interrompu', 4096).content,
        { hangUpAfterMs: 150 },
      );
      expect(interrupted.response).toBe('');

      await backgroundWorkDone(testApp);
      expect(await prisma.kycDocument.count({ where: { caseId: draft.id } })).toBe(0);
      expect(storage.files()).toEqual(filesBefore);
      // Le service répond toujours, et le dossier accepte un envoi normal.
      await upload(member, draft.id, 'SELFIE', jpeg('envoi normal')).expect(201);
    });

    it('un envoi irrecevable est refusé sans attendre le fichier', async () => {
      const member = await customer();
      const submitted = await submittedIdentity(member);
      const stranger = await customer();
      const strangerDraft = caseOf(
        await put(stranger.accessToken, '/me/verification/identity', identityDeclaration()).expect(
          200,
        ),
      );
      const filesBefore = storage.files();
      const port = await listeningPort();

      // 200 Ko annoncés, dont seuls les premiers octets partent : la réponse ne peut venir que
      // de contrôles faits avant la lecture du corps.
      const attempt = async (
        sender: Member,
        caseId: string,
        kind: string,
      ): Promise<{ response: string; elapsedMs: number }> => {
        const startedAt = Date.now();
        const { response } = await rawExchange(
          port,
          [
            `POST /api/v1/me/verification/cases/${caseId}/documents?kind=${kind} HTTP/1.1`,
            'Host: localhost',
            `Authorization: Bearer ${sender.accessToken}`,
            `X-Forwarded-For: ${newClientIp()}`,
            'Content-Type: image/jpeg',
            'Content-Length: 200000',
            '',
            '',
          ].join('\r\n'),
          jpeg('début d’un envoi irrecevable', 4096).content,
          { hangUpAfterMs: 3000, hangUpOnceAnswered: true },
        );
        return { response, elapsedMs: Date.now() - startedAt };
      };

      // Dossier déjà déposé : il ne reçoit plus de pièce.
      const frozen = await attempt(member, submitted.id, 'SELFIE');
      expect(frozen.response).toMatch(/^HTTP\/1\.1 409 /);
      expect(frozen.response).toContain('"code":"CONFLICT"');
      expect(frozen.elapsedMs).toBeLessThan(2500);
      // Dossier d'un autre compte : il « n'existe pas ».
      const foreign = await attempt(member, strangerDraft.id, 'SELFIE');
      expect(foreign.response).toMatch(/^HTTP\/1\.1 404 /);
      expect(foreign.elapsedMs).toBeLessThan(2500);
      // Pièce étrangère au niveau du dossier.
      const misplaced = await attempt(stranger, strangerDraft.id, 'PROOF_OF_ADDRESS');
      expect(misplaced.response).toMatch(/^HTTP\/1\.1 422 /);
      expect(misplaced.elapsedMs).toBeLessThan(2500);

      await backgroundWorkDone(testApp);
      expect(storage.files()).toEqual(filesBefore);
      expect((await fetchCase(member, submitted.id)).documents).toHaveLength(2);
      expect((await fetchCase(stranger, strangerDraft.id)).documents).toHaveLength(0);
    });

    it('au-delà de huit réceptions simultanées, l’envoi est refusé aussitôt — et rien d’autre n’est touché', async () => {
      const slots = testApp.app.get(KycUploadSlots);
      const senders = await Promise.all(
        Array.from({ length: KYC_UPLOADS_IN_FLIGHT_MAX }, () => customer()),
      );
      const drafts = await Promise.all(
        senders.map(async (sender) =>
          caseOf(
            await put(
              sender.accessToken,
              '/me/verification/identity',
              identityDeclaration(),
            ).expect(200),
          ),
        ),
      );
      const filesBefore = storage.files();
      const port = await listeningPort();
      expect(slots.inFlight).toBe(0);

      // Huit envois commencés et laissés en suspens : chacun occupe une réception.
      const pending = senders.map((sender, index) => {
        const socket = connect(port, '127.0.0.1');
        socket.on('error', () => undefined);
        socket.on('connect', () => {
          socket.write(
            [
              `POST /api/v1/me/verification/cases/${drafts[index]?.id ?? ''}/documents?kind=SELFIE HTTP/1.1`,
              'Host: localhost',
              `Authorization: Bearer ${sender.accessToken}`,
              `X-Forwarded-For: ${newClientIp()}`,
              'Content-Type: image/jpeg',
              'Content-Length: 200000',
              '',
              '',
            ].join('\r\n'),
          );
          socket.write(jpeg(`en suspens ${String(index)}`, 4096).content);
        });
        return socket;
      });
      try {
        await eventually(() => Promise.resolve(slots.inFlight === KYC_UPLOADS_IN_FLIGHT_MAX));

        // Le neuvième est refusé sans attendre, avec le délai à respecter.
        const ninth = await customer();
        const ninthDraft = caseOf(
          await put(ninth.accessToken, '/me/verification/identity', identityDeclaration()).expect(
            200,
          ),
        );
        const startedAt = Date.now();
        const refused = await upload(ninth, ninthDraft.id, 'SELFIE', jpeg('neuvième')).expect(503);
        expect(Date.now() - startedAt).toBeLessThan(2000);
        expect(codeOf(refused)).toBe('SERVICE_UNAVAILABLE');
        expect(refused.headers['retry-after']).toBe('5');
        expect(refused.headers['connection']).toBe('close');
        // Un refus n'occupe pas de réception, et le reste de l'API répond normalement.
        expect(slots.inFlight).toBe(KYC_UPLOADS_IN_FLIGHT_MAX);
        await get(ninth.accessToken, '/me/verification').expect(200);
        await get(ninth.accessToken, `/me/verification/cases/${ninthDraft.id}`).expect(200);
        await put(ninth.accessToken, '/me/verification/identity', identityDeclaration()).expect(
          200,
        );

        // Un envoi interrompu rend sa place : le neuvième passe dès qu'une réception se libère.
        pending[0]?.destroy();
        await eventually(() => Promise.resolve(slots.inFlight === KYC_UPLOADS_IN_FLIGHT_MAX - 1));
        await upload(ninth, ninthDraft.id, 'SELFIE', jpeg('neuvième, second essai')).expect(201);
        expect(slots.inFlight).toBe(KYC_UPLOADS_IN_FLIGHT_MAX - 1);
      } finally {
        for (const socket of pending) {
          socket.destroy();
        }
      }
      await eventually(() => Promise.resolve(slots.inFlight === 0));

      // Les envois abandonnés n'ont rien laissé : ni pièce, ni fichier.
      expect(
        await prisma.kycDocument.count({ where: { caseId: { in: drafts.map(({ id }) => id) } } }),
      ).toBe(0);
      expect(storage.files()).toHaveLength(filesBefore.length + 1);
    });

    it('retirer une pièce efface son fichier', async () => {
      const member = await customer();
      const draft = await identityDraft(member);
      const selfie = draft.documents.find(({ kind }) => kind === 'SELFIE');
      if (selfie === undefined) {
        throw new Error('Missing selfie.');
      }
      const selfieFile = `${selfie.id.slice(-2)}/${selfie.id}`;
      expect(storage.files()).toContain(selfieFile);

      const after = caseOf(
        await del(
          member.accessToken,
          `/me/verification/cases/${draft.id}/documents/${selfie.id}`,
        ).expect(200),
      );
      expect(after.documents.map(({ kind }) => kind)).toEqual(['IDENTITY_FRONT']);
      expect(after.missingDocuments).toEqual(['SELFIE']);
      expect(storage.files()).not.toContain(selfieFile);

      await del(member.accessToken, `/me/verification/cases/${draft.id}/documents/${selfie.id}`)
        .expect(404)
        .then((response) => {
          expect(response.body.detail).toBe('Document not found.');
        });
      const [removed] = await auditEntries('kyc_case.document_removed', draft.id);
      expect(removed?.metadata).toEqual({ documentId: selfie.id });
    });

    it('abandonner un dossier en préparation l’efface avec ses pièces', async () => {
      const member = await customer();
      const draft = await identityDraft(member);
      const files = await storedFilesOf(draft.id);
      expect(storage.files()).toEqual(expect.arrayContaining(files));

      await del(member.accessToken, `/me/verification/cases/${draft.id}`).expect(204);

      expect(await prisma.kycCase.count({ where: { id: draft.id } })).toBe(0);
      expect(await prisma.kycDocument.count({ where: { caseId: draft.id } })).toBe(0);
      for (const file of files) {
        expect(storage.files()).not.toContain(file);
      }
      await get(member.accessToken, `/me/verification/cases/${draft.id}`).expect(404);
      await del(member.accessToken, `/me/verification/cases/${draft.id}`).expect(404);
      const [discarded] = await auditEntries('kyc_case.discarded', draft.id);
      expect(discarded?.metadata).toEqual({ documents: 2 });

      // Rien n'empêche de recommencer.
      const again = caseOf(
        await put(member.accessToken, '/me/verification/identity', identityDeclaration()).expect(
          200,
        ),
      );
      expect(again.id).not.toBe(draft.id);
    });

    it('le dossier d’un autre compte « n’existe pas »', async () => {
      const owner = await customer();
      const intruder = await customer();
      const draft = await identityDraft(owner);
      const [document] = draft.documents;
      const filesBefore = storage.files();

      for (const response of [
        await get(intruder.accessToken, `/me/verification/cases/${draft.id}`),
        await upload(intruder, draft.id, 'SELFIE', jpeg('intruder')),
        await del(
          intruder.accessToken,
          `/me/verification/cases/${draft.id}/documents/${document?.id ?? ''}`,
        ),
        await post(intruder.accessToken, `/me/verification/cases/${draft.id}/submit`),
        await del(intruder.accessToken, `/me/verification/cases/${draft.id}`),
      ]) {
        expect(response.status).toBe(404);
        expect(response.body.detail).toBe('Verification case not found.');
      }

      expect(storage.files()).toEqual(filesBefore);
      expect((await fetchCase(owner, draft.id)).documents).toHaveLength(2);
    });
  });

  describe('déposer un dossier', () => {
    it('refuse un dossier incomplet, puis fige le dossier déposé', async () => {
      const member = await customer();
      const draft = caseOf(
        await put(
          member.accessToken,
          '/me/verification/identity',
          identityDeclaration({ document: { type: 'DRIVING_LICENCE' } }),
        ).expect(200),
      );
      const submitPath = `/me/verification/cases/${draft.id}/submit`;

      const empty = await post(member.accessToken, submitPath).expect(422);
      expect(empty.body.detail).toBe(
        'Documents are missing: IDENTITY_FRONT, IDENTITY_BACK, SELFIE.',
      );
      await upload(member, draft.id, 'IDENTITY_FRONT', jpeg('permis recto')).expect(201);
      await upload(member, draft.id, 'SELFIE', jpeg('permis selfie')).expect(201);
      // Un permis a deux faces : sans le verso, le dossier reste incomplet.
      const withoutBack = await post(member.accessToken, submitPath).expect(422);
      expect(withoutBack.body.detail).toBe('Documents are missing: IDENTITY_BACK.');
      await upload(member, draft.id, 'IDENTITY_BACK', jpeg('permis verso')).expect(201);

      const submitted = caseOf(await post(member.accessToken, submitPath).expect(200));
      expect(submitted).toMatchObject({ id: draft.id, status: 'SUBMITTED', missingDocuments: [] });
      expect(submitted.submittedAt).not.toBeNull();
      expect(submitted.documents).toHaveLength(3);

      // Déposé, le dossier est une preuve : plus rien n'y change.
      const [document] = submitted.documents;
      const filesBefore = storage.files();
      for (const response of [
        await put(member.accessToken, '/me/verification/identity', identityDeclaration()),
        await upload(member, draft.id, 'SELFIE', jpeg('après dépôt')),
        await del(
          member.accessToken,
          `/me/verification/cases/${draft.id}/documents/${document?.id ?? ''}`,
        ),
        await del(member.accessToken, `/me/verification/cases/${draft.id}`),
        await post(member.accessToken, submitPath),
      ]) {
        expect(response.status).toBe(409);
        expect(codeOf(response)).toBe('CONFLICT');
      }
      expect(storage.files()).toEqual(filesBefore);
      expect(await fetchCase(member, draft.id)).toEqual(submitted);

      const overview = await overviewOf(member);
      expect(overview.level).toBe(0);
      expect(overview.levels[0]).toMatchObject({
        verified: false,
        available: false,
        currentCase: { id: draft.id, status: 'SUBMITTED' },
      });

      const [entry] = await auditEntries('kyc_case.submitted', draft.id);
      expect(entry).toMatchObject({ actorId: member.id, outcome: 'SUCCESS' });
      expect(entry?.metadata).toEqual({ level: 1, documents: 3 });
      expect(await activityTypes(member)).toContain('IDENTITY_VERIFICATION_SUBMITTED');
    });
  });

  describe('accès du personnel', () => {
    it('réserve l’examen aux permissions kyc.*, avec la validation en deux étapes', async () => {
      const member = await customer();
      const submitted = await submittedIdentity(member);
      const [document] = submitted.documents;
      const paths = [
        '/admin/kyc/cases',
        `/admin/kyc/cases/${submitted.id}`,
        `/admin/kyc/cases/${submitted.id}/documents/${document?.id ?? ''}`,
      ];

      // Un client, et un agent du support, n'y ont pas accès.
      const support = await staff('support');
      for (const accessToken of [member.accessToken, support.accessToken]) {
        for (const path of paths) {
          expect(codeOf(await get(accessToken, path).expect(403))).toBe('FORBIDDEN');
        }
        for (const action of ['approve', 'reject', 'revoke']) {
          const refused = await post(accessToken, `/admin/kyc/cases/${submitted.id}/${action}`, {
            reasons: ['OTHER'],
            note: NOTE,
            reason: NOTE,
          }).expect(403);
          expect(codeOf(refused)).toBe('FORBIDDEN');
        }
      }

      // Un agent de conformité sans second facteur non plus.
      const user = await registerVerifiedUser(http, testApp, { email: newEmail('compliance') });
      const first = await login(http, user);
      await grantAsOwner(first.user.id, 'compliance');
      const withoutSecondFactor = (await login(http, user)).tokens.accessToken;
      for (const path of paths) {
        expect(codeOf(await get(withoutSecondFactor, path).expect(403))).toBe(
          'MFA_ENROLLMENT_REQUIRED',
        );
      }

      // L'agent de conformité détient les trois permissions, la lecture des comptes et leur
      // clôture.
      const me = currentUserSchema.parse((await get(claire.accessToken, '/me').expect(200)).body);
      expect(me.roles).toEqual(['compliance']);
      expect([...me.permissions].sort()).toEqual([
        'kyc.read',
        'kyc.review',
        'kyc.revoke',
        'users.close',
        'users.read',
      ]);
      for (const path of paths) {
        await get(claire.accessToken, path).expect(200);
      }

      // Rien n'a changé pendant ces refus.
      expect((await fetchCase(member, submitted.id)).status).toBe('SUBMITTED');
    });

    it('une permission par action : consulter n’autorise pas à décider, ni décider à retirer', async () => {
      // Deux rôles sur mesure, créés comme le ferait une migration (rôle propriétaire).
      await withOwner(testApp, async (owner) => {
        for (const [key, permissions] of [
          ['kyc_reader', ['kyc.read']],
          ['kyc_reviewer', ['kyc.read', 'kyc.review']],
        ] as const) {
          const role = await owner.role.create({
            data: { key, name: key, description: 'Rôle de test : permissions séparées.' },
          });
          await owner.rolePermission.createMany({
            data: permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })),
          });
        }
      });
      const reader = await staff('kyc_reader');
      const reviewer = await staff('kyc_reviewer');
      const member = await customer();
      const submitted = await submittedIdentity(member);
      const [document] = submitted.documents;
      const caseUrl = `/admin/kyc/cases/${submitted.id}`;
      const decisions = {
        approve: {},
        reject: { reasons: ['OTHER'], note: NOTE },
        revoke: { reason: NOTE },
      } as const;

      // kyc.read : consulter la file, la fiche et les pièces — rien d'autre.
      for (const path of [
        '/admin/kyc/cases',
        caseUrl,
        `${caseUrl}/documents/${document?.id ?? ''}`,
      ]) {
        await get(reader.accessToken, path).expect(200);
        await get(reviewer.accessToken, path).expect(200);
      }
      for (const [action, body] of Object.entries(decisions)) {
        expect(
          codeOf(await post(reader.accessToken, `${caseUrl}/${action}`, body).expect(403)),
        ).toBe('FORBIDDEN');
      }
      expect((await fetchCase(member, submitted.id)).status).toBe('SUBMITTED');

      // kyc.review : accepter ou refuser — pas retirer.
      expect((await approve(reviewer, submitted.id)).status).toBe('APPROVED');
      expect(
        codeOf(await post(reviewer.accessToken, `${caseUrl}/revoke`, decisions.revoke).expect(403)),
      ).toBe('FORBIDDEN');
      expect(await levelOf(member)).toBe(1);

      // kyc.revoke : seule la conformité, qui détient les trois, retire la vérification.
      const revoked = adminCaseOf(
        await post(claire.accessToken, `${caseUrl}/revoke`, decisions.revoke).expect(200),
      );
      expect(revoked.status).toBe('REVOKED');
      expect(await levelOf(member)).toBe(0);
    });

    it('un agent de conformité se nomme à quatre yeux ; le rôle retiré, il n’examine plus rien', async () => {
      // Deux administrateurs : l'un demande le changement de rôle, l'autre l'approuve.
      const [alice, bruno] = await Promise.all(
        [0, 1].map(async () => {
          const created = await createAdmin(testApp);
          const session = await login(http, created);
          return { ...created, accessToken: session.tokens.accessToken };
        }),
      );
      if (alice === undefined || bruno === undefined) {
        throw new Error('Missing administrators.');
      }
      const changeRole = async (userId: string, action: 'GRANT' | 'REVOKE') => {
        const requested = await post(alice.accessToken, '/admin/role-changes', {
          userId,
          roleKey: 'compliance',
          action,
          reason: 'Affectation au service conformité, ticket RH 2026-0412',
        }).expect(201);
        const requestId = (requested.body as { id: string }).id;
        await post(bruno.accessToken, `/admin/role-changes/${requestId}/approve`).expect(200);
      };

      // Emma est une cliente comme les autres, puis nommée à la conformité par les deux.
      const user = await registerVerifiedUser(http, testApp, { email: newEmail('emma') });
      const first = await login(http, user);
      const totpSecret = await enableSecondFactor(testApp, {
        id: first.user.id,
        password: user.password,
      });
      const signIn = async () => (await login(http, { ...user, totpSecret })).tokens.accessToken;
      const pending = await submittedIdentity(await customer());
      const other = await submittedIdentity(await customer());

      const before = await signIn();
      expect(codeOf(await get(before, `/admin/kyc/cases/${pending.id}`).expect(403))).toBe(
        'FORBIDDEN',
      );

      await changeRole(first.user.id, 'GRANT');
      const emma = await signIn();
      expect(adminCaseOf(await get(emma, `/admin/kyc/cases/${pending.id}`).expect(200)).id).toBe(
        pending.id,
      );
      const approved = adminCaseOf(
        await post(emma, `/admin/kyc/cases/${pending.id}/approve`).expect(200),
      );
      expect(approved.status).toBe('APPROVED');
      expect(approved.decision?.decidedBy).toEqual({ id: first.user.id, email: user.email });

      // Le rôle retiré, le droit disparaît — y compris pour le jeton déjà émis.
      await changeRole(first.user.id, 'REVOKE');
      for (const accessToken of [emma, await signIn()]) {
        expect(codeOf(await get(accessToken, `/admin/kyc/cases/${other.id}`).expect(403))).toBe(
          'FORBIDDEN',
        );
        expect(
          codeOf(await post(accessToken, `/admin/kyc/cases/${other.id}/approve`).expect(403)),
        ).toBe('FORBIDDEN');
        expect(
          codeOf(
            await post(accessToken, `/admin/kyc/cases/${pending.id}/revoke`, {
              reason: NOTE,
            }).expect(403),
          ),
        ).toBe('FORBIDDEN');
      }
      expect(
        adminCaseOf(await get(claire.accessToken, `/admin/kyc/cases/${other.id}`).expect(200))
          .status,
      ).toBe('SUBMITTED');
      // Ce qu'elle a décidé quand elle en avait le droit reste acquis.
      expect(
        adminCaseOf(await get(claire.accessToken, `/admin/kyc/cases/${pending.id}`).expect(200))
          .status,
      ).toBe('APPROVED');
    });

    it('la file reste traitable quand la fonctionnalité est fermée aux titulaires, et pendant la maintenance', async () => {
      const member = await customer();
      const submitted = await submittedIdentity(member);
      const settings = testApp.app.get(SystemSettingsService);
      const context = { actor: { type: 'SYSTEM' } as const, reason: 'test: kyc closed' };

      await settings.setFeatureEnabled('kyc', false, context);
      await settings.set('maintenance.mode', { enabled: true, message: null }, context);
      try {
        expect(codeOf(await get(member.accessToken, '/me/verification').expect(503))).toBe(
          'MAINTENANCE',
        );
        await get(claire.accessToken, `/admin/kyc/cases/${submitted.id}`).expect(200);
        await settings.set('maintenance.mode', { enabled: false, message: null }, context);
        expect(codeOf(await get(member.accessToken, '/me/verification').expect(403))).toBe(
          'FEATURE_DISABLED',
        );
        expect((await approve(claire, submitted.id)).status).toBe('APPROVED');
      } finally {
        await settings.set('maintenance.mode', { enabled: false, message: null }, context);
        await settings.setFeatureEnabled('kyc', true, context);
      }
      expect(await levelOf(member)).toBe(1);
    });
  });

  describe('examiner un dossier', () => {
    it('la file présente les dossiers déposés, du plus ancien au plus récent, page par page', async () => {
      const members = [await customer(), await customer(), await customer()];
      const submitted: KycCase[] = [];
      for (const member of members) {
        testClock.advance(1000);
        submitted.push(await submittedIdentity(member));
      }
      const draftOwner = await customer();
      const draft = await identityDraft(draftOwner);
      const ids = submitted.map(({ id }) => id);

      // Parcours complet, deux par deux.
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = adminKycCaseListSchema.parse(
          (
            await get(
              claire.accessToken,
              `/admin/kyc/cases?limit=2${cursor === null ? '' : `&after=${cursor}`}`,
            ).expect(200)
          ).body,
        );
        expect(page.cases.length).toBeLessThanOrEqual(2);
        expect(page.cases.every(({ status }) => status === 'SUBMITTED')).toBe(true);
        seen.push(...page.cases.map(({ id }) => id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 50);
      expect(cursor).toBeNull();

      // Aucun doublon, aucun dossier en préparation, et l'ordre des dépôts est respecté.
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).not.toContain(draft.id);
      expect(seen.filter((id) => ids.includes(id))).toEqual(ids);
      const all = await prisma.kycCase.findMany({
        where: { status: 'SUBMITTED' },
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      expect(seen).toEqual(all.map(({ id }) => id));

      // Filtres.
      const [first, second] = members;
      const ofFirst = adminKycCaseListSchema.parse(
        (await get(claire.accessToken, `/admin/kyc/cases?userId=${first?.id ?? ''}`).expect(200))
          .body,
      );
      expect(ofFirst.cases).toEqual([
        {
          id: ids[0],
          level: 1,
          status: 'SUBMITTED',
          user: { id: first?.id, email: first?.email },
          submittedAt: submitted[0]?.submittedAt,
          decidedAt: null,
        },
      ]);
      expect(ofFirst.nextCursor).toBeNull();

      await approve(claire, ids[1] ?? '');
      const approved = adminKycCaseListSchema.parse(
        (
          await get(
            claire.accessToken,
            `/admin/kyc/cases?status=APPROVED&userId=${second?.id ?? ''}`,
          ).expect(200)
        ).body,
      );
      expect(approved.cases.map(({ id }) => id)).toEqual([ids[1]]);
      expect(approved.cases[0]?.decidedAt).not.toBeNull();
      const levelTwo = adminKycCaseListSchema.parse(
        (await get(claire.accessToken, '/admin/kyc/cases?level=2&limit=100').expect(200)).body,
      );
      expect(levelTwo.cases.every(({ level }) => level === 2)).toBe(true);
      expect(levelTwo.cases.map(({ id }) => id)).not.toContain(ids[0]);

      // Les dossiers en préparation ne se demandent pas ; un curseur forgé est refusé.
      await get(claire.accessToken, '/admin/kyc/cases?status=DRAFT').expect(400);
      for (const forged of ['abc', Buffer.from('2026-01-01|x').toString('base64url'), '%00']) {
        expect(
          errorPaths(await get(claire.accessToken, `/admin/kyc/cases?after=${forged}`).expect(400)),
        ).toEqual(['after']);
      }
      await get(claire.accessToken, '/admin/kyc/cases?limit=101').expect(400);

      // Chaque page consultée laisse une trace.
      const listed = await prisma.auditLog.findMany({
        where: { action: 'kyc_case.listed_by_admin', actorId: claire.id },
        orderBy: { id: 'desc' },
        take: 1,
      });
      expect(listed[0]?.metadata).toMatchObject({ status: 'SUBMITTED', level: 2, limit: 100 });
    });

    it('la fiche donne tout ce qu’il faut pour juger : numéro complet, pièces, doublons, historique', async () => {
      const member = await customer();
      const number = newDocumentNumber();
      const submitted = await submittedIdentity(member, { document: { number } });

      const view = adminCaseOf(
        await get(claire.accessToken, `/admin/kyc/cases/${submitted.id}`).expect(200),
      );
      expect(view).toMatchObject({
        id: submitted.id,
        level: 1,
        status: 'SUBMITTED',
        submittedAt: submitted.submittedAt,
        user: {
          id: member.id,
          email: member.email,
          status: 'ACTIVE',
          accountType: 'INDIVIDUAL',
          countryCode: 'CD',
          verificationLevel: 0,
        },
        identity: {
          givenName: 'Jean',
          familyName: 'Mukendi',
          additionalName: 'Kabongo',
          dateOfBirth: '1990-05-17',
          document: { type: 'PASSPORT', number, issuingCountry: 'CD' },
        },
        address: null,
        sourceOfFunds: null,
        decision: null,
        ending: null,
        replacesCaseId: null,
        sameIdentityDocument: { total: 0, cases: [] },
        history: [],
      });
      expect(
        view.documents.map(({ kind, seenOnOtherAccounts }) => [kind, seenOnOtherAccounts]),
      ).toEqual([
        ['IDENTITY_FRONT', 0],
        ['SELFIE', 0],
      ]);

      const [viewed] = await auditEntries('kyc_case.viewed_by_admin', submitted.id);
      expect(viewed).toMatchObject({ actorId: claire.id, outcome: 'SUCCESS' });
      expect(viewed?.metadata).toEqual({ userId: member.id, level: 1 });

      // Un dossier en préparation, ou inconnu, n'existe pas pour le personnel.
      const draft = await identityDraft(await customer());
      await get(claire.accessToken, `/admin/kyc/cases/${draft.id}`).expect(404);
      await get(claire.accessToken, `/admin/kyc/cases/${UNKNOWN_ID}`).expect(404);
      await post(claire.accessToken, `/admin/kyc/cases/${draft.id}/approve`).expect(404);
      await get(claire.accessToken, '/admin/kyc/cases/not-a-uuid').expect(400);
    });

    it('une pièce est rendue à l’identique, en pièce jointe, et chaque téléchargement est tracé', async () => {
      const member = await customer();
      const draft = caseOf(
        await put(member.accessToken, '/me/verification/identity', identityDeclaration()).expect(
          200,
        ),
      );
      const front = pdf('passeport scanné', 300_000);
      const selfie = jpeg('autoportrait', 80_000);
      await upload(member, draft.id, 'IDENTITY_FRONT', front).expect(201);
      const complete = caseOf(await upload(member, draft.id, 'SELFIE', selfie).expect(201));
      await submit(member, draft.id);

      for (const [kind, file, extension] of [
        ['IDENTITY_FRONT', front, 'pdf'],
        ['SELFIE', selfie, 'jpg'],
      ] as const) {
        const document = complete.documents.find((candidate) => candidate.kind === kind);
        const response = await get(
          david.accessToken,
          `/admin/kyc/cases/${draft.id}/documents/${document?.id ?? ''}`,
        )
          .buffer(true)
          .parse((stream, callback) => {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
              callback(null, Buffer.concat(chunks));
            });
          })
          .expect(200);

        expect(Buffer.isBuffer(response.body)).toBe(true);
        expect((response.body as Buffer).equals(file.content)).toBe(true);
        expect(response.headers['content-type']).toBe(file.contentType);
        expect(response.headers['content-length']).toBe(String(file.content.length));
        expect(response.headers['content-disposition']).toBe(
          `attachment; filename="${kind.toLowerCase()}-${document?.id ?? ''}.${extension}"`,
        );
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['cache-control']).toBe('no-store');
      }

      const downloads = await auditEntries('kyc_document.viewed_by_admin', draft.id);
      expect(downloads).toHaveLength(2);
      expect(downloads.every((entry) => entry.actorId === david.id)).toBe(true);
      expect(downloads.map((entry) => entry.outcome)).toEqual(['SUCCESS', 'SUCCESS']);
      expect(downloads.map((entry) => (entry.metadata as { kind: string }).kind)).toEqual([
        'IDENTITY_FRONT',
        'SELFIE',
      ]);

      await get(david.accessToken, `/admin/kyc/cases/${draft.id}/documents/${UNKNOWN_ID}`).expect(
        404,
      );
      // Le titulaire, lui, ne peut pas retélécharger ses pièces : la route n'existe pas.
      const [document] = complete.documents;
      await get(
        member.accessToken,
        `/me/verification/cases/${draft.id}/documents/${document?.id ?? ''}`,
      ).expect(404);
    });

    it('une pièce altérée, échangée ou disparue n’est jamais rendue : l’incident est tracé', async () => {
      const member = await customer();
      const submitted = await submittedIdentity(member);
      const [front, selfie] = await prisma.kycDocument.findMany({
        where: { caseId: submitted.id },
        orderBy: { createdAt: 'asc' },
      });
      if (front === undefined || selfie === undefined) {
        throw new Error('Missing documents.');
      }
      const pathOf = (key: string) => join(storage.directory, key);
      const download = (documentId: string) =>
        get(claire.accessToken, `/admin/kyc/cases/${submitted.id}/documents/${documentId}`);
      const originalFront = storage.read(front.storageKey);
      const originalSelfie = storage.read(selfie.storageKey);

      // Un seul bit modifié.
      const flipped = Buffer.from(originalFront);
      flipped[100] = (flipped[100] ?? 0) ^ 0x01;
      writeFileSync(pathOf(front.storageKey), flipped);
      const altered = await download(front.id).expect(500);
      expect(codeOf(altered)).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(altered.body)).not.toContain(front.storageKey);

      // Deux fichiers chiffrés échangés : chacun ne se déchiffre que pour sa propre pièce.
      writeFileSync(pathOf(front.storageKey), originalSelfie);
      writeFileSync(pathOf(selfie.storageKey), originalFront);
      await download(front.id).expect(500);
      await download(selfie.id).expect(500);

      // Fichier disparu.
      rmSync(pathOf(front.storageKey));
      await download(front.id).expect(500);

      const failures = await prisma.auditLog.findMany({
        where: {
          action: 'kyc_document.viewed_by_admin',
          resourceId: submitted.id,
          outcome: 'FAILURE',
        },
      });
      expect(failures).toHaveLength(4);

      // Remis en place, tout se relit.
      writeFileSync(pathOf(front.storageKey), originalFront);
      writeFileSync(pathOf(selfie.storageKey), originalSelfie);
      await download(front.id).expect(200);
      await download(selfie.id).expect(200);
    });
  });

  describe('décider', () => {
    it('accepter vérifie le niveau : le profil reprend l’identité vérifiée et ne se modifie plus', async () => {
      const member = await customer();
      // Ce que le titulaire avait déclaré lui-même, avant toute vérification.
      await http
        .patch('/api/v1/me/profile')
        .set(bearer(member.accessToken))
        .send({ givenName: 'Johnny', familyName: 'Muk', city: 'Goma', timeZone: 'Africa/Kinshasa' })
        .expect(200);
      const submitted = await submittedIdentity(member, { givenName: 'Jean-Pierre' });

      const decided = adminCaseOf(
        await post(claire.accessToken, `/admin/kyc/cases/${submitted.id}/approve`, {
          note: 'Pièce conforme au registre',
        }).expect(200),
      );
      expect(decided.status).toBe('APPROVED');
      expect(decided.decision).toEqual({
        decidedBy: { id: claire.id, email: claire.email },
        decidedAt: decided.decision?.decidedAt,
        note: 'Pièce conforme au registre',
        rejectionReasons: [],
      });
      expect(decided.user.verificationLevel).toBe(1);

      // Côté titulaire.
      expect(await levelOf(member)).toBe(1);
      const overview = await overviewOf(member);
      expect(overview.level).toBe(1);
      expect(overview.levels[0]).toMatchObject({
        verified: true,
        verifiedAt: decided.decision?.decidedAt,
        available: true,
        currentCase: { id: submitted.id, status: 'APPROVED' },
      });
      expect(overview.levels[1]).toMatchObject({ verified: false, available: true });
      expect(overview.levels[2]).toMatchObject({ verified: false, available: false });

      const mine = await fetchCase(member, submitted.id);
      expect(mine.status).toBe('APPROVED');
      // Ni l'examinateur, ni sa note ne sont rendus au titulaire.
      expect(JSON.stringify(mine)).not.toContain('registre');
      expect(JSON.stringify(mine)).not.toContain(claire.email);
      expect(JSON.stringify(mine)).not.toContain(claire.id);

      const profile = profileSchema.parse(
        (await get(member.accessToken, '/me/profile').expect(200)).body,
      );
      expect(profile).toMatchObject({
        givenName: 'Jean-Pierre',
        familyName: 'Mukendi',
        additionalName: 'Kabongo',
        dateOfBirth: '1990-05-17',
        placeOfBirth: 'Lubumbashi',
        nationality: 'CD',
        identityVerified: true,
        // L'adresse, elle, reste celle que le titulaire a déclarée.
        city: 'Goma',
        addressVerified: false,
        timeZone: 'Africa/Kinshasa',
      });

      // Ce qui est vérifié ne se change plus par le profil ; le reste, si.
      const locked = await http
        .patch('/api/v1/me/profile')
        .set(bearer(member.accessToken))
        .send({ givenName: 'Johnny', dateOfBirth: '1991-01-01', city: 'Bukavu' })
        .expect(409);
      expect(codeOf(locked)).toBe('CONFLICT');
      expect(errorPaths(locked)).toEqual(['dateOfBirth', 'givenName']);
      const stillFree = profileSchema.parse(
        (
          await http
            .patch('/api/v1/me/profile')
            .set(bearer(member.accessToken))
            .send({ city: 'Bukavu', timeZone: 'Africa/Lubumbashi' })
            .expect(200)
        ).body,
      );
      expect(stillFree).toMatchObject({
        givenName: 'Jean-Pierre',
        city: 'Bukavu',
        timeZone: 'Africa/Lubumbashi',
      });

      // Le titulaire est prévenu, sans lien ni nom d'examinateur.
      const mail = await nextMessageOf(testApp, member.email, 'identity_verification_approved');
      expect(mail.subject).toBe('MG-Exchange — vérification acceptée (niveau 1)');
      expect(mail.text).toContain('votre identité');
      expect(mail.text).not.toContain(claire.email);

      // Son historique le mentionne, sans dire qui a décidé.
      const activity = activityListSchema.parse(
        (await get(member.accessToken, '/me/activity?limit=100').expect(200)).body,
      );
      const entry = activity.entries.find(({ type }) => type === 'IDENTITY_VERIFICATION_APPROVED');
      expect(entry).toBeDefined();
      expect(JSON.stringify(activity)).not.toContain(claire.email);
      expect(JSON.stringify(activity)).not.toContain(claire.id);
      // L'examinatrice, elle, n'a pas « été vérifiée » : rien dans son propre historique.
      expect(await activityTypes(claire)).not.toContain('IDENTITY_VERIFICATION_APPROVED');

      // La fiche du compte, au back-office, reflète la vérification.
      const admin = await createAdmin(testApp);
      const adminSession = await login(http, admin);
      const detail = adminUserDetailSchema.parse(
        (await get(adminSession.tokens.accessToken, `/admin/users/${member.id}`).expect(200)).body,
      );
      expect(detail.verification).toEqual({
        level: 1,
        identityVerified: true,
        addressVerified: false,
      });
      expect(detail.profile).toMatchObject({
        givenName: 'Jean-Pierre',
        placeOfBirth: 'Lubumbashi',
      });

      // Deux traces : une sur le dossier (avec la note), une sur le compte (sans).
      const [onCase] = await auditEntries('kyc_case.approved', submitted.id);
      expect(onCase).toMatchObject({ actorId: claire.id, outcome: 'SUCCESS' });
      expect(onCase?.metadata).toEqual({
        userId: member.id,
        level: 1,
        note: 'Pièce conforme au registre',
        replacedCaseId: null,
      });
      const [onUser] = await auditEntries('user.verification_approved', member.id);
      expect(onUser?.metadata).toEqual({ caseId: submitted.id, level: 1 });
    });

    it('refuser donne ses motifs au titulaire — jamais la note —, et lui laisse recommencer', async () => {
      const member = await customer();
      const submitted = await submittedIdentity(member);
      const rejectPath = `/admin/kyc/cases/${submitted.id}/reject`;

      // Un refus est motivé : au moins un motif, sans doublon, et une note interne.
      for (const [body, paths] of [
        [{ reasons: ['SELFIE_MISMATCH'] }, ['note']],
        [{ reasons: [], note: NOTE }, ['reasons']],
        [{ reasons: ['OTHER', 'OTHER'], note: NOTE }, ['reasons']],
        [{ reasons: ['NOT_A_REASON'], note: NOTE }, ['reasons.0']],
        [{ reasons: ['OTHER'], note: 'court' }, ['note']],
        [
          {
            reasons: [
              'DOCUMENT_UNREADABLE',
              'DOCUMENT_EXPIRED',
              'DOCUMENT_NOT_ACCEPTED',
              'DOCUMENT_INCOMPLETE',
              'INFORMATION_MISMATCH',
              'SELFIE_UNUSABLE',
            ],
            note: NOTE,
          },
          ['reasons'],
        ],
      ] as const) {
        const refused = await post(claire.accessToken, rejectPath, { ...body }).expect(400);
        expect(errorPaths(refused)).toEqual(paths);
      }
      expect((await fetchCase(member, submitted.id)).status).toBe('SUBMITTED');

      const decided = adminCaseOf(
        await post(claire.accessToken, rejectPath, {
          reasons: ['SELFIE_MISMATCH', 'DOCUMENT_UNREADABLE'],
          note: NOTE,
        }).expect(200),
      );
      expect(decided.status).toBe('REJECTED');
      expect(decided.decision).toMatchObject({
        decidedBy: { id: claire.id },
        note: NOTE,
        rejectionReasons: ['SELFIE_MISMATCH', 'DOCUMENT_UNREADABLE'],
      });

      // Le titulaire voit les motifs, pas la note.
      const mine = await fetchCase(member, submitted.id);
      expect(mine).toMatchObject({
        status: 'REJECTED',
        rejectionReasons: ['SELFIE_MISMATCH', 'DOCUMENT_UNREADABLE'],
        missingDocuments: [],
      });
      expect(JSON.stringify(mine)).not.toContain('ticket');
      expect(await levelOf(member)).toBe(0);

      const mail = await nextMessageOf(testApp, member.email, 'identity_verification_rejected');
      expect(mail.text).toContain(
        "L'autoportrait ne correspond pas à la photographie de la pièce.",
      );
      expect(mail.text).toContain('Une pièce est illisible');
      expect(mail.text).not.toContain('ticket');
      expect(await activityTypes(member)).toContain('IDENTITY_VERIFICATION_REJECTED');

      // Un dossier refusé ne se rouvre pas…
      for (const response of [
        await post(claire.accessToken, `/admin/kyc/cases/${submitted.id}/approve`),
        await post(david.accessToken, rejectPath, { reasons: ['OTHER'], note: NOTE }),
        await post(claire.accessToken, `/admin/kyc/cases/${submitted.id}/revoke`, { reason: NOTE }),
        await post(member.accessToken, `/me/verification/cases/${submitted.id}/submit`),
        await del(member.accessToken, `/me/verification/cases/${submitted.id}`),
      ]) {
        expect(response.status).toBe(409);
      }

      // … mais le titulaire peut en préparer un autre, qui est un nouveau dossier.
      const overview = await overviewOf(member);
      expect(overview.levels[0]).toMatchObject({
        verified: false,
        available: true,
        currentCase: {
          id: submitted.id,
          status: 'REJECTED',
          rejectionReasons: ['SELFIE_MISMATCH', 'DOCUMENT_UNREADABLE'],
        },
      });
      const second = await submittedIdentity(member);
      expect(second.id).not.toBe(submitted.id);
      const view = adminCaseOf(
        await get(claire.accessToken, `/admin/kyc/cases/${second.id}`).expect(200),
      );
      expect(view.history).toEqual([
        {
          id: submitted.id,
          level: 1,
          status: 'REJECTED',
          submittedAt: submitted.submittedAt,
          decidedAt: decided.decision?.decidedAt,
        },
      ]);
      // Les pièces du dossier refusé restent conservées : c'est une preuve.
      expect(storage.files()).toEqual(expect.arrayContaining(await storedFilesOf(submitted.id)));
    });

    it('nul n’examine son propre dossier', async () => {
      const officer = await staff('compliance');
      const submitted = await submittedIdentity(officer);
      const [document] = submitted.documents;

      for (const response of [
        await get(officer.accessToken, `/admin/kyc/cases/${submitted.id}`),
        await get(
          officer.accessToken,
          `/admin/kyc/cases/${submitted.id}/documents/${document?.id ?? ''}`,
        ),
        await post(officer.accessToken, `/admin/kyc/cases/${submitted.id}/approve`),
        await post(officer.accessToken, `/admin/kyc/cases/${submitted.id}/reject`, {
          reasons: ['OTHER'],
          note: NOTE,
        }),
      ]) {
        expect(response.status).toBe(403);
        expect(codeOf(response)).toBe('FORBIDDEN');
        expect(response.body.detail).toMatch(/your own verification case/);
      }
      expect((await fetchCase(officer, submitted.id)).status).toBe('SUBMITTED');
      expect(await levelOf(officer)).toBe(0);

      const denials = await prisma.auditLog.findMany({
        where: { actorId: officer.id, resourceId: submitted.id, outcome: 'DENIED' },
        orderBy: { id: 'asc' },
      });
      expect(denials.map(({ action }) => action)).toEqual([
        'kyc_case.view_denied',
        'kyc_document.view_denied',
        'kyc_case.approval_denied',
        'kyc_case.rejection_denied',
      ]);
      expect(
        denials.every(({ metadata }) => (metadata as { reason: string }).reason === 'OWN_CASE'),
      ).toBe(true);

      // Un collègue peut décider, et l'intéressé ne peut pas retirer sa propre vérification… ni
      // la voir retirée par lui-même.
      await approve(claire, submitted.id);
      expect(await levelOf(officer)).toBe(1);
      const selfRevoke = await post(
        officer.accessToken,
        `/admin/kyc/cases/${submitted.id}/revoke`,
        {
          reason: NOTE,
        },
      ).expect(403);
      expect(selfRevoke.body.detail).toMatch(/your own verification case/);
      expect(await levelOf(officer)).toBe(1);
    });

    it('une même pièce d’identité ne vérifie qu’un seul compte ; un même fichier vu ailleurs est signalé', async () => {
      const first = await customer();
      const second = await customer();
      const number = newDocumentNumber();
      const sharedSelfie = jpeg('le même autoportrait sur deux comptes');

      const firstDraft = await identityDraft(first, { document: { number } });
      await upload(first, firstDraft.id, 'SELFIE', sharedSelfie).expect(201);
      await submit(first, firstDraft.id);
      await approve(claire, firstDraft.id);

      // Le second compte présente la même pièce, écrite autrement, et le même autoportrait.
      const secondDraft = await identityDraft(second, {
        givenName: 'Paul',
        document: {
          number: `${number.slice(0, 2).toLowerCase()} ${number.slice(2, 5)}.${number.slice(5)}`,
        },
      });
      await upload(second, secondDraft.id, 'SELFIE', sharedSelfie).expect(201);
      await submit(second, secondDraft.id);

      // Un autre compte prépare un dossier avec la même pièce et le même autoportrait, sans le
      // déposer : un dossier en préparation n'est connu que de son titulaire, et ne compte pas
      // parmi les doublons signalés à l'examinateur.
      const hesitant = await customer();
      const hesitantDraft = await identityDraft(hesitant, { document: { number } });
      await upload(hesitant, hesitantDraft.id, 'SELFIE', sharedSelfie).expect(201);

      const view = adminCaseOf(
        await get(claire.accessToken, `/admin/kyc/cases/${secondDraft.id}`).expect(200),
      );
      expect(view.identity?.document.number).toBe(number);
      expect(view.sameIdentityDocument).toEqual({
        total: 1,
        cases: [{ caseId: firstDraft.id, userId: first.id, status: 'APPROVED' }],
      });
      expect(
        Object.fromEntries(
          view.documents.map(({ kind, seenOnOtherAccounts }) => [kind, seenOnOtherAccounts]),
        ),
      ).toEqual({ IDENTITY_FRONT: 0, SELFIE: 1 });

      const refused = await post(
        claire.accessToken,
        `/admin/kyc/cases/${secondDraft.id}/approve`,
      ).expect(409);
      expect(refused.body.detail).toBe(
        'Another account is already verified with this identity document.',
      );
      expect((await fetchCase(second, secondDraft.id)).status).toBe('SUBMITTED');
      expect(await levelOf(second)).toBe(0);
      expect(await auditEntries('kyc_case.approved', secondDraft.id)).toEqual([]);

      // Une pièce d'une autre nature portant le même numéro est une autre pièce.
      const third = await customer();
      const thirdDraft = await identityDraft(third, {
        document: { type: 'NATIONAL_ID_CARD', number, expiresOn: null },
      });
      await upload(third, thirdDraft.id, 'IDENTITY_BACK', jpeg('verso de la carte')).expect(201);
      await submit(third, thirdDraft.id);
      const thirdView = adminCaseOf(
        await get(claire.accessToken, `/admin/kyc/cases/${thirdDraft.id}`).expect(200),
      );
      expect(thirdView.sameIdentityDocument.total).toBe(0);
      expect((await approve(claire, thirdDraft.id)).status).toBe('APPROVED');

      // Une fois la première vérification retirée, la pièce peut vérifier l'autre compte.
      await post(claire.accessToken, `/admin/kyc/cases/${firstDraft.id}/revoke`, {
        reason: 'Usurpation établie : la pièce appartient au second compte',
      }).expect(200);
      expect((await approve(claire, secondDraft.id)).status).toBe('APPROVED');
      expect(await levelOf(first)).toBe(0);
      expect(await levelOf(second)).toBe(1);
    });
  });

  describe('retirer une vérification', () => {
    it('le niveau retombe, le profil redevient déclaratif, le titulaire est prévenu sans le motif', async () => {
      const member = await verifiedCustomer(1);
      const [approvedCase] = await prisma.kycCase.findMany({ where: { userId: member.id } });
      const caseId = approvedCase?.id ?? '';
      const revokePath = `/admin/kyc/cases/${caseId}/revoke`;

      // Un retrait est motivé.
      expect(errorPaths(await post(claire.accessToken, revokePath, {}).expect(400))).toEqual([
        'reason',
      ]);
      expect(
        errorPaths(await post(claire.accessToken, revokePath, { reason: 'court' }).expect(400)),
      ).toEqual(['reason']);
      expect(await levelOf(member)).toBe(1);

      const reason = 'Pièce reconnue fausse par l’autorité émettrice, dossier 2026-0417';
      const revoked = adminCaseOf(
        await post(david.accessToken, revokePath, { reason }).expect(200),
      );
      expect(revoked.status).toBe('REVOKED');
      expect(revoked.ending).toEqual({
        endedAt: revoked.ending?.endedAt,
        revokedBy: { id: david.id, email: david.email },
        revocationReason: reason,
      });
      // La décision d'origine reste lisible : qui avait accepté, et quand.
      expect(revoked.decision?.decidedBy.id).toBe(claire.id);
      expect(revoked.user.verificationLevel).toBe(0);

      expect(await levelOf(member)).toBe(0);
      const mine = await fetchCase(member, caseId);
      expect(mine.status).toBe('REVOKED');
      expect(mine.endedAt).toBe(revoked.ending?.endedAt);
      expect(JSON.stringify(mine)).not.toContain('fausse');
      const profile = profileSchema.parse(
        (await get(member.accessToken, '/me/profile').expect(200)).body,
      );
      expect(profile).toMatchObject({
        givenName: null,
        placeOfBirth: null,
        nationality: null,
        identityVerified: false,
      });
      // Le profil se modifie de nouveau.
      await http
        .patch('/api/v1/me/profile')
        .set(bearer(member.accessToken))
        .send({ givenName: 'Jean' })
        .expect(200);

      const mail = await nextMessageOf(testApp, member.email, 'identity_verification_revoked');
      expect(mail.text).toContain("n'est plus valable");
      expect(mail.text).not.toContain('fausse');
      expect(await activityTypes(member)).toContain('IDENTITY_VERIFICATION_REVOKED');

      // Un retrait ne se répète pas, et ne s'applique qu'à une vérification en vigueur.
      await post(claire.accessToken, revokePath, { reason }).expect(409);
      const pending = await submittedIdentity(member);
      const notInForce = await post(claire.accessToken, `/admin/kyc/cases/${pending.id}/revoke`, {
        reason,
      }).expect(409);
      expect(notInForce.body.detail).toMatch(/Only an approved case in force can be revoked/);

      const [onCase] = await auditEntries('kyc_case.revoked', caseId);
      expect(onCase).toMatchObject({ actorId: david.id });
      expect(onCase?.metadata).toEqual({ userId: member.id, level: 1, reason });
      const [onUser] = await auditEntries('user.verification_revoked', member.id);
      expect(onUser?.metadata).toEqual({ caseId, level: 1 });
    });
  });

  describe('niveaux 2 et 3', () => {
    it('les niveaux s’obtiennent dans l’ordre', async () => {
      const member = await customer();

      const early = await put(
        member.accessToken,
        '/me/verification/address',
        addressDeclaration(),
      ).expect(409);
      expect(early.body.detail).toBe('Level 1 must be verified before level 2.');
      await put(member.accessToken, '/me/verification/source-of-funds', fundsDeclaration()).expect(
        409,
      );

      // Un niveau 1 seulement déposé ne suffit pas : il faut qu'il soit accepté.
      const identity = await submittedIdentity(member);
      await put(member.accessToken, '/me/verification/address', addressDeclaration()).expect(409);
      await approve(claire, identity.id);
      await put(member.accessToken, '/me/verification/source-of-funds', fundsDeclaration())
        .expect(409)
        .then((response) => {
          expect(response.body.detail).toBe('Level 2 must be verified before level 3.');
        });
      expect(await prisma.kycCase.count({ where: { userId: member.id } })).toBe(1);
    });

    it('un niveau dont le précédent a été retiré entre-temps ne s’accepte plus', async () => {
      const member = await verifiedCustomer(1);
      const identityCase = await prisma.kycCase.findFirstOrThrow({ where: { userId: member.id } });
      const address = await submittedAddress(member);

      await post(claire.accessToken, `/admin/kyc/cases/${identityCase.id}/revoke`, {
        reason: 'Pièce signalée perdue puis utilisée par un tiers',
      }).expect(200);

      const view = adminCaseOf(
        await get(claire.accessToken, `/admin/kyc/cases/${address.id}`).expect(200),
      );
      expect(view.user.verificationLevel).toBe(0);
      const refused = await post(
        claire.accessToken,
        `/admin/kyc/cases/${address.id}/approve`,
      ).expect(409);
      expect(refused.body.detail).toBe(
        'Level 1 is no longer verified for this account: this case cannot be approved.',
      );
      expect((await fetchCase(member, address.id)).status).toBe('SUBMITTED');

      // Il reste possible de le refuser, pour vider la file.
      expect((await reject(claire, address.id)).status).toBe('REJECTED');
      expect(await levelOf(member)).toBe(0);
    });

    it('niveau 2 : adresse dans le pays du compte, justificatif récent, une à trois pièces', async () => {
      const member = await verifiedCustomer(1);
      const save = (overrides: Parameters<typeof addressDeclaration>[0]) =>
        put(member.accessToken, '/me/verification/address', addressDeclaration(overrides));

      expect(errorPaths(await save({ country: 'CG' }).expect(400))).toEqual(['country']);
      expect(errorPaths(await save({ proof: { issuedOn: dayFromNow(-93) } }).expect(400))).toEqual([
        'proof.issuedOn',
      ]);
      expect(errorPaths(await save({ proof: { issuedOn: dayFromNow(1) } }).expect(400))).toEqual([
        'proof.issuedOn',
      ]);
      expect(errorPaths(await save({ city: '' }).expect(400))).toEqual(['city']);

      const draft = caseOf(
        await save({
          addressLine2: 'Quartier Matonge',
          proof: { issuedOn: dayFromNow(-92) },
        }).expect(200),
      );
      expect(draft).toMatchObject({
        level: 2,
        status: 'DRAFT',
        identity: null,
        sourceOfFunds: null,
        missingDocuments: ['PROOF_OF_ADDRESS'],
        address: {
          addressLine1: '12 avenue Kasa-Vubu',
          addressLine2: 'Quartier Matonge',
          city: 'Kinshasa',
          country: 'CD',
          proof: { type: 'UTILITY_BILL', issuedOn: dayFromNow(-92) },
        },
      });

      // Les pièces d'un autre niveau n'y ont pas leur place.
      await upload(member, draft.id, 'SELFIE', jpeg('selfie niveau 2')).expect(422);
      // Jusqu'à trois justificatifs, qui s'ajoutent ; pas un de plus.
      for (const label of ['facture', 'relevé', 'attestation']) {
        await upload(member, draft.id, 'PROOF_OF_ADDRESS', pdf(label)).expect(201);
      }
      const fourth = await upload(member, draft.id, 'PROOF_OF_ADDRESS', pdf('de trop')).expect(409);
      expect(fourth.body.detail).toBe(
        'At most 3 PROOF_OF_ADDRESS documents can be attached: remove one first.',
      );
      expect(await storedFilesOf(draft.id)).toHaveLength(3);
      expect(storage.files()).toEqual(expect.arrayContaining(await storedFilesOf(draft.id)));

      await submit(member, draft.id);
      const view = adminCaseOf(
        await get(claire.accessToken, `/admin/kyc/cases/${draft.id}`).expect(200),
      );
      expect(view.address?.city).toBe('Kinshasa');
      expect(view.identity).toBeNull();
      expect(view.user.verificationLevel).toBe(1);
      expect(view.history.map(({ level, status }) => [level, status])).toEqual([[1, 'APPROVED']]);
      await approve(claire, draft.id);

      expect(await levelOf(member)).toBe(2);
      const profile = profileSchema.parse(
        (await get(member.accessToken, '/me/profile').expect(200)).body,
      );
      expect(profile).toMatchObject({
        addressLine1: '12 avenue Kasa-Vubu',
        addressLine2: 'Quartier Matonge',
        city: 'Kinshasa',
        region: 'Kinshasa',
        postalCode: null,
        addressVerified: true,
        identityVerified: true,
      });
      const locked = await http
        .patch('/api/v1/me/profile')
        .set(bearer(member.accessToken))
        .send({ city: 'Goma', postalCode: '1234' })
        .expect(409);
      expect(errorPaths(locked)).toEqual(['city', 'postalCode']);
    });

    it('niveau 3 : origine des fonds ; retirer le niveau 1 fait retomber tout le compte', async () => {
      const member = await verifiedCustomer(2);
      const save = (overrides: Parameters<typeof fundsDeclaration>[0]) =>
        put(member.accessToken, '/me/verification/source-of-funds', fundsDeclaration(overrides));

      expect(errorPaths(await save({ sources: [] }).expect(400))).toEqual(['sources']);
      expect(errorPaths(await save({ sources: ['SAVINGS', 'SAVINGS'] }).expect(400))).toEqual([
        'sources',
      ]);
      expect(errorPaths(await save({ explanation: 'Mon salaire.' }).expect(400))).toEqual([
        'explanation',
      ]);

      const draft = caseOf(await save({ employerName: null }).expect(200));
      expect(draft).toMatchObject({
        level: 3,
        missingDocuments: ['SOURCE_OF_FUNDS'],
        sourceOfFunds: {
          sources: ['EMPLOYMENT', 'SAVINGS'],
          occupation: 'Ingénieur des mines',
          employerName: null,
        },
      });
      for (let index = 1; index <= 5; index += 1) {
        await upload(member, draft.id, 'SOURCE_OF_FUNDS', pdf(`bulletin ${String(index)}`)).expect(
          201,
        );
      }
      await upload(member, draft.id, 'SOURCE_OF_FUNDS', pdf('bulletin 6')).expect(409);
      await submit(member, draft.id);
      await approve(david, draft.id);
      expect(await levelOf(member)).toBe(3);
      expect((await overviewOf(member)).levels.map(({ verified }) => verified)).toEqual([
        true,
        true,
        true,
      ]);

      // Le niveau 1 est retiré : les niveaux 2 et 3 restent acceptés, mais ne comptent plus.
      const identityCase = await prisma.kycCase.findFirstOrThrow({
        where: { userId: member.id, level: 1 },
      });
      await post(claire.accessToken, `/admin/kyc/cases/${identityCase.id}/revoke`, {
        reason: 'Pièce signalée volée par son titulaire légitime',
      }).expect(200);
      expect(await levelOf(member)).toBe(0);
      const fallen = await overviewOf(member);
      expect(fallen.level).toBe(0);
      expect(fallen.levels.map(({ verified }) => verified)).toEqual([false, true, true]);
      // Seul le niveau 1 peut être repris : les suivants attendent qu'il soit de nouveau vérifié.
      expect(fallen.levels.map(({ available }) => available)).toEqual([true, false, false]);
      await put(member.accessToken, '/me/verification/address', addressDeclaration()).expect(409);
      // L'adresse vérifiée ne vaut plus : le profil ne la présente plus comme telle.
      const profile = profileSchema.parse(
        (await get(member.accessToken, '/me/profile').expect(200)).body,
      );
      expect(profile).toMatchObject({ identityVerified: false, addressVerified: false });

      // Le niveau 1 de nouveau vérifié, le compte retrouve son niveau 3.
      await approve(claire, (await submittedIdentity(member)).id);
      expect(await levelOf(member)).toBe(3);

      // Le niveau 3 retiré seul : le compte retombe au niveau 2, et l'avis nomme ce niveau.
      const firstNotice = await nextMessageOf(
        testApp,
        member.email,
        'identity_verification_revoked',
      );
      expect(firstNotice.subject).toContain('(niveau 1)');
      await post(claire.accessToken, `/admin/kyc/cases/${draft.id}/revoke`, {
        reason: 'Bulletins de salaire reconnus falsifiés',
      }).expect(200);
      expect(await levelOf(member)).toBe(2);
      const notice = await nextMessageOf(testApp, member.email, 'identity_verification_revoked', 2);
      expect(notice.subject).toContain('(niveau 3)');
      expect(notice.text).toContain("La vérification de l'origine de vos fonds (niveau 3)");
      expect(notice.text).not.toContain('falsifiés');
    });

    it('renouveler une pièce : le nouveau dossier accepté remplace l’ancien, sans interruption', async () => {
      const member = await verifiedCustomer(1);
      const original = await prisma.kycCase.findFirstOrThrow({ where: { userId: member.id } });

      // Pendant que le nouveau dossier est préparé puis examiné, l'ancien reste en vigueur.
      const renewal = await submittedIdentity(member, { familyName: 'Mukendi-Tshisekedi' });
      expect(await levelOf(member)).toBe(1);
      const profileBefore = profileSchema.parse(
        (await get(member.accessToken, '/me/profile').expect(200)).body,
      );
      expect(profileBefore.familyName).toBe('Mukendi');

      const view = adminCaseOf(
        await get(claire.accessToken, `/admin/kyc/cases/${renewal.id}`).expect(200),
      );
      expect(view.replacesCaseId).toBe(original.id);
      expect(view.user.verificationLevel).toBe(1);

      const decided = await approve(claire, renewal.id);
      expect(decided.replacesCaseId).toBeNull();
      const superseded = adminCaseOf(
        await get(claire.accessToken, `/admin/kyc/cases/${original.id}`).expect(200),
      );
      expect(superseded.status).toBe('SUPERSEDED');
      expect(superseded.ending).toEqual({
        endedAt: decided.decision?.decidedAt,
        revokedBy: null,
        revocationReason: null,
      });

      expect(await levelOf(member)).toBe(1);
      const profileAfter = profileSchema.parse(
        (await get(member.accessToken, '/me/profile').expect(200)).body,
      );
      expect(profileAfter.familyName).toBe('Mukendi-Tshisekedi');
      expect((await fetchCase(member, original.id)).status).toBe('SUPERSEDED');
      const [onCase] = await auditEntries('kyc_case.approved', renewal.id);
      expect((onCase?.metadata as { replacedCaseId: string }).replacedCaseId).toBe(original.id);

      // Un dossier remplacé ne se retire plus.
      await post(claire.accessToken, `/admin/kyc/cases/${original.id}/revoke`, {
        reason: 'Tentative de retrait d’un dossier déjà remplacé',
      }).expect(409);
    });
  });

  describe('accès concurrents (PostgreSQL réel)', () => {
    it('deux premiers enregistrements simultanés ne créent qu’un dossier', async () => {
      const member = await customer();
      const number = newDocumentNumber();

      const responses = await Promise.all(
        ['Jean', 'Jeanne', 'Johan', 'Joël'].map((givenName) =>
          put(
            member.accessToken,
            '/me/verification/identity',
            identityDeclaration({ givenName, document: { number } }),
          ).then((response) => response),
        ),
      );

      expect(responses.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
      const cases = await prisma.kycCase.findMany({ where: { userId: member.id } });
      expect(cases).toHaveLength(1);
      expect(new Set(responses.map((response) => caseOf(response).id))).toEqual(
        new Set([cases[0]?.id]),
      );
      expect(['Jean', 'Jeanne', 'Johan', 'Joël']).toContain(cases[0]?.givenName);
    });

    it('envois simultanés d’une pièce unique : il n’en reste qu’une, et qu’un seul fichier', async () => {
      const member = await customer();
      const draft = caseOf(
        await put(member.accessToken, '/me/verification/identity', identityDeclaration()).expect(
          200,
        ),
      );
      const filesBefore = storage.files();

      const responses = await Promise.all(
        [1, 2, 3, 4, 5].map((index) =>
          upload(member, draft.id, 'SELFIE', jpeg(`autoportrait ${String(index)}`)).then(
            (response) => response,
          ),
        ),
      );

      expect(responses.map(({ status }) => status)).toEqual([201, 201, 201, 201, 201]);
      const documents = await prisma.kycDocument.findMany({ where: { caseId: draft.id } });
      expect(documents).toHaveLength(1);
      // Aucun fichier orphelin : le stockage ne compte qu'un fichier de plus.
      const added = storage.files().filter((file) => !filesBefore.includes(file));
      expect(added).toEqual([documents[0]?.storageKey]);
    });

    it('envois simultanés de justificatifs : jamais plus que le maximum, aucun fichier orphelin', async () => {
      const member = await verifiedCustomer(1);
      const draft = caseOf(
        await put(member.accessToken, '/me/verification/address', addressDeclaration()).expect(200),
      );
      const filesBefore = storage.files();

      const responses = await Promise.all(
        [1, 2, 3, 4, 5, 6, 7].map((index) =>
          upload(member, draft.id, 'PROOF_OF_ADDRESS', pdf(`justificatif ${String(index)}`)).then(
            (response) => response,
          ),
        ),
      );

      const statuses = responses.map(({ status }) => status).sort();
      expect(statuses).toEqual([201, 201, 201, 409, 409, 409, 409]);
      const documents = await prisma.kycDocument.findMany({ where: { caseId: draft.id } });
      expect(documents).toHaveLength(3);
      const added = storage.files().filter((file) => !filesBefore.includes(file));
      expect(added).toEqual(documents.map(({ storageKey }) => storageKey).sort());
    });

    it('dépôt, retrait de pièce et envoi simultanés : le dossier déposé est complet et figé', async () => {
      for (let round = 0; round < 6; round += 1) {
        const member = await customer();
        const draft = await identityDraft(member);
        const selfie = draft.documents.find(({ kind }) => kind === 'SELFIE');
        const filesBefore = storage.files();

        const [submission, removal, replacement] = await Promise.all([
          post(member.accessToken, `/me/verification/cases/${draft.id}/submit`).then((r) => r),
          del(
            member.accessToken,
            `/me/verification/cases/${draft.id}/documents/${selfie?.id ?? ''}`,
          ).then((r) => r),
          upload(member, draft.id, 'IDENTITY_FRONT', jpeg(`nouveau recto ${String(round)}`)).then(
            (r) => r,
          ),
        ]);

        expect([200, 409, 422]).toContain(submission.status);
        expect([200, 409]).toContain(removal.status);
        expect([201, 409]).toContain(replacement.status);

        const after = await fetchCase(member, draft.id);
        const kinds = after.documents.map(({ kind }) => kind).sort();
        if (submission.status === 200) {
          // Déposé : il a ses deux pièces obligatoires — un retrait accepté n'a pu que précéder
          // le dépôt, qui aurait alors été refusé.
          expect(after.status).toBe('SUBMITTED');
          expect(kinds).toEqual(['IDENTITY_FRONT', 'SELFIE']);
          expect(removal.status).toBe(409);
        } else {
          expect(after.status).toBe('DRAFT');
        }
        // Le stockage correspond exactement aux pièces enregistrées : ni manque, ni orphelin.
        const expected = await storedFilesOf(draft.id);
        const present = storage
          .files()
          .filter((file) => !filesBefore.includes(file) || expected.includes(file));
        const obsolete = filesBefore.filter(
          (file) => draft.documents.some(({ id }) => file.endsWith(id)) && !expected.includes(file),
        );
        expect(present.filter((file) => expected.includes(file)).sort()).toEqual(expected);
        for (const file of obsolete) {
          expect(storage.files()).not.toContain(file);
        }
        expect(
          storage
            .files()
            .filter((file) => !filesBefore.includes(file))
            .every((file) => expected.includes(file)),
        ).toBe(true);
      }
    });

    it('trois dépôts simultanés du même dossier : un seul aboutit', async () => {
      const member = await customer();
      const draft = await identityDraft(member);

      const responses = await Promise.all(
        [1, 2, 3].map(() =>
          post(member.accessToken, `/me/verification/cases/${draft.id}/submit`).then((r) => r),
        ),
      );

      expect(responses.map(({ status }) => status).sort()).toEqual([200, 409, 409]);
      expect(await auditEntries('kyc_case.submitted', draft.id)).toHaveLength(1);
      expect((await fetchCase(member, draft.id)).status).toBe('SUBMITTED');
    });

    it('deux décisions simultanées et contraires : une seule est prise, un seul avis part', async () => {
      for (let round = 0; round < 4; round += 1) {
        const member = await customer();
        const submitted = await submittedIdentity(member);
        const mailsBefore = mailbox(testApp).messagesFor(member.email).length;

        const [approval, rejection] = await Promise.all([
          post(claire.accessToken, `/admin/kyc/cases/${submitted.id}/approve`).then((r) => r),
          post(david.accessToken, `/admin/kyc/cases/${submitted.id}/reject`, {
            reasons: ['INFORMATION_MISMATCH'],
            note: NOTE,
          }).then((r) => r),
        ]);

        expect([approval.status, rejection.status].sort()).toEqual([200, 409]);
        const approved = approval.status === 200;
        const final = await prisma.kycCase.findUniqueOrThrow({ where: { id: submitted.id } });
        expect(final.status).toBe(approved ? 'APPROVED' : 'REJECTED');
        expect(final.decidedBy).toBe(approved ? claire.id : david.id);
        expect(final.rejectionReasons).toEqual(approved ? [] : ['INFORMATION_MISMATCH']);
        expect(await levelOf(member)).toBe(approved ? 1 : 0);

        expect(await auditEntries('kyc_case.approved', submitted.id)).toHaveLength(
          approved ? 1 : 0,
        );
        expect(await auditEntries('kyc_case.rejected', submitted.id)).toHaveLength(
          approved ? 0 : 1,
        );
        await backgroundWorkDone(testApp);
        // La boîte rend les messages du plus récent au plus ancien.
        const received = mailbox(testApp).messagesFor(member.email);
        const mails = received.slice(0, received.length - mailsBefore);
        expect(mails.map(({ template }) => template)).toEqual([
          approved ? 'identity_verification_approved' : 'identity_verification_rejected',
        ]);
      }
    });

    it('la même pièce d’identité acceptée au même instant sur deux comptes : un seul compte est vérifié', async () => {
      for (let round = 0; round < 3; round += 1) {
        const number = newDocumentNumber();
        const first = await customer();
        const second = await customer();
        const firstCase = await submittedIdentity(first, { document: { number } });
        const secondCase = await submittedIdentity(second, { document: { number } });

        const responses = await Promise.all([
          post(claire.accessToken, `/admin/kyc/cases/${firstCase.id}/approve`).then((r) => r),
          post(david.accessToken, `/admin/kyc/cases/${secondCase.id}/approve`).then((r) => r),
        ]);

        expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
        const levels = [await levelOf(first), await levelOf(second)].sort();
        expect(levels).toEqual([0, 1]);
        expect(
          await prisma.kycCase.count({
            where: { id: { in: [firstCase.id, secondCase.id] }, status: 'APPROVED' },
          }),
        ).toBe(1);
        expect(
          await prisma.kycCase.count({
            where: { id: { in: [firstCase.id, secondCase.id] }, status: 'SUBMITTED' },
          }),
        ).toBe(1);
      }
    });

    it('acceptation du renouvellement et retrait de l’ancien dossier au même instant : jamais deux dossiers en vigueur', async () => {
      for (let round = 0; round < 4; round += 1) {
        const member = await verifiedCustomer(1);
        const original = await prisma.kycCase.findFirstOrThrow({ where: { userId: member.id } });
        const renewal = await submittedIdentity(member);

        const [approval, revocation] = await Promise.all([
          post(claire.accessToken, `/admin/kyc/cases/${renewal.id}/approve`).then((r) => r),
          post(david.accessToken, `/admin/kyc/cases/${original.id}/revoke`, {
            reason: 'Retrait demandé pendant le renouvellement',
          }).then((r) => r),
        ]);

        expect(approval.status).toBe(200);
        expect([200, 409]).toContain(revocation.status);
        const cases = await prisma.kycCase.findMany({
          where: { userId: member.id },
          orderBy: { id: 'asc' },
        });
        expect(cases.map(({ status }) => status)).toEqual([
          revocation.status === 200 ? 'REVOKED' : 'SUPERSEDED',
          'APPROVED',
        ]);
        expect(cases[0]?.endedAt).not.toBeNull();
        expect(await levelOf(member)).toBe(1);
      }
    });
  });

  describe('limites par compte', () => {
    it('au plus cinq dépôts par jour', async () => {
      const member = await customer();
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const submitted = await submittedIdentity(member);
        await reject(claire, submitted.id);
      }
      const sixth = await identityDraft(member);

      const limited = await post(
        member.accessToken,
        `/me/verification/cases/${sixth.id}/submit`,
      ).expect(429);
      expect(codeOf(limited)).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect((await fetchCase(member, sixth.id)).status).toBe('DRAFT');
      // Une tentative refusée pour une autre raison ne consomme pas de dépôt : les cinq dépôts
      // comptés sont bien ceux qui ont abouti.
      expect(
        await prisma.auditLog.count({
          where: { action: 'kyc_case.submitted', actorId: member.id },
        }),
      ).toBe(5);
    });

    it('au plus trente enregistrements par heure, et quarante envois par heure', async () => {
      const member = await customer();
      const declaration = identityDeclaration();
      let draft: KycCase | undefined;
      for (let attempt = 1; attempt <= 30; attempt += 1) {
        draft = caseOf(
          await put(member.accessToken, '/me/verification/identity', declaration).expect(200),
        );
      }
      expect(
        codeOf(await put(member.accessToken, '/me/verification/identity', declaration).expect(429)),
      ).toBe('RATE_LIMITED');

      const caseId = draft?.id ?? '';
      for (let attempt = 1; attempt <= 40; attempt += 1) {
        await upload(member, caseId, 'SELFIE', jpeg(`envoi ${String(attempt)}`)).expect(201);
      }
      const filesBefore = storage.files();
      const limited = await upload(member, caseId, 'SELFIE', jpeg('envoi 41')).expect(429);
      expect(codeOf(limited)).toBe('RATE_LIMITED');
      expect(storage.files()).toEqual(filesBefore);
      // Chaque remplacement a effacé le fichier précédent : il n'en reste qu'un.
      expect(await storedFilesOf(caseId)).toHaveLength(1);
    });
  });

  describe('contrôles refaits au dépôt, purge des dossiers abandonnés', () => {
    it('une pièce expirée entre l’enregistrement et le dépôt fait refuser le dépôt', async () => {
      const member = await customer();
      const draft = await identityDraft(member, { document: { expiresOn: dayFromNow(3) } });

      testClock.advance(3 * DAY_MS);

      const refused = await post(
        member.accessToken,
        `/me/verification/cases/${draft.id}/submit`,
      ).expect(422);
      expect(codeOf(refused)).toBe('UNPROCESSABLE_ENTITY');
      expect(errorPaths(refused)).toEqual(['document.expiresOn']);
      expect((await fetchCase(member, draft.id)).status).toBe('DRAFT');

      // Corrigé, le dossier se dépose.
      await put(
        member.accessToken,
        '/me/verification/identity',
        identityDeclaration({ document: { expiresOn: dayFromNow(900) } }),
      ).expect(200);
      expect((await submit(member, draft.id)).status).toBe('SUBMITTED');
    });

    it('un justificatif de domicile devenu trop ancien fait refuser le dépôt', async () => {
      const member = await verifiedCustomer(1);
      const draft = caseOf(
        await put(
          member.accessToken,
          '/me/verification/address',
          addressDeclaration({ proof: { issuedOn: dayFromNow(-91) } }),
        ).expect(200),
      );
      await upload(member, draft.id, 'PROOF_OF_ADDRESS', pdf('facture ancienne')).expect(201);

      testClock.advance(2 * DAY_MS);

      const refused = await post(
        member.accessToken,
        `/me/verification/cases/${draft.id}/submit`,
      ).expect(422);
      expect(errorPaths(refused)).toEqual(['proof.issuedOn']);
    });

    it('un dossier resté en préparation trente jours est effacé avec ses pièces ; un dossier déposé ne l’est jamais', async () => {
      const maintenance = testApp.app.get(AccountMaintenanceService);
      const abandoned = await customer();
      const active = await customer();
      const depositor = await customer();
      const abandonedDraft = await identityDraft(abandoned);
      const activeDraft = await identityDraft(active);
      const submitted = await submittedIdentity(depositor);
      const abandonedFiles = await storedFilesOf(abandonedDraft.id);
      const keptFiles = [
        ...(await storedFilesOf(activeDraft.id)),
        ...(await storedFilesOf(submitted.id)),
      ];

      // Vingt-neuf jours : ces dossiers-ci ne bougent pas (ceux, plus anciens, que les tests
      // précédents ont laissés en préparation peuvent, eux, être effacés).
      testClock.advance(29 * DAY_MS);
      expect((await maintenance.run()).failures).toBe(0);
      expect((await fetchCase(abandoned, abandonedDraft.id)).status).toBe('DRAFT');
      expect(storage.files()).toEqual(expect.arrayContaining(abandonedFiles));

      // Le titulaire actif reprend son dossier : le délai repart de là.
      await upload(active, activeDraft.id, 'SELFIE', jpeg('autoportrait repris')).expect(201);
      const activeFiles = await storedFilesOf(activeDraft.id);
      testClock.advance(2 * DAY_MS);

      const draftsBefore = await prisma.kycCase.count({ where: { status: 'DRAFT' } });
      const report = await maintenance.run();
      expect(report.failures).toBe(0);
      expect(report.otherSteps['purge-stale-kyc-drafts']).toBeGreaterThanOrEqual(1);
      expect(await prisma.kycCase.count({ where: { status: 'DRAFT' } })).toBe(
        draftsBefore - (report.otherSteps['purge-stale-kyc-drafts'] ?? 0),
      );

      // Le dossier abandonné a disparu, lignes et fichiers.
      expect(await prisma.kycCase.count({ where: { id: abandonedDraft.id } })).toBe(0);
      expect(await prisma.kycDocument.count({ where: { caseId: abandonedDraft.id } })).toBe(0);
      for (const file of abandonedFiles) {
        expect(storage.files()).not.toContain(file);
      }
      await get(abandoned.accessToken, `/me/verification/cases/${abandonedDraft.id}`).expect(404);
      expect((await overviewOf(abandoned)).levels[0]).toMatchObject({
        available: true,
        currentCase: null,
      });
      const [purged] = await auditEntries('kyc_case.draft_purged', abandonedDraft.id);
      expect(purged).toMatchObject({ actorType: 'SYSTEM', actorId: null, outcome: 'SUCCESS' });
      expect(purged?.metadata).toMatchObject({
        userId: abandoned.id,
        reason: 'NEVER_SUBMITTED',
        documents: 2,
      });

      // Le dossier repris et le dossier déposé sont intacts.
      expect((await fetchCase(active, activeDraft.id)).status).toBe('DRAFT');
      expect((await fetchCase(depositor, submitted.id)).status).toBe('SUBMITTED');
      expect(storage.files()).toEqual(expect.arrayContaining(activeFiles));
      expect(storage.files()).toEqual(expect.arrayContaining(await storedFilesOf(submitted.id)));
      expect(keptFiles.length).toBeGreaterThan(0);

      // Un dossier déposé reste, même des années plus tard.
      testClock.advance(400 * DAY_MS);
      await maintenance.run();
      expect((await fetchCase(depositor, submitted.id)).status).toBe('SUBMITTED');
      expect(storage.files()).toEqual(expect.arrayContaining(await storedFilesOf(submitted.id)));
      // Le stockage ne contient aucun fichier qui ne corresponde à une pièce enregistrée.
      const known = (await prisma.kycDocument.findMany({ select: { storageKey: true } })).map(
        ({ storageKey }) => storageKey,
      );
      expect(storage.files().filter((file) => !known.includes(file))).toEqual([]);
      expect(known.filter((file) => !storage.files().includes(file))).toEqual([]);
    });
  });
});

describe('Vérification d’identité sans stockage chiffré configuré — bout en bout', () => {
  let testApp: TestApp;
  let http: Http;

  beforeAll(async () => {
    // Ni KYC_STORAGE_DIR, ni KYC_ENCRYPTION_KEY : l'état d'une installation qui n'a pas encore
    // préparé la vérification d'identité.
    testApp = await createTestApp({ env: { TRUST_PROXY_HOPS: '1' } });
    http = request(testApp.app.getHttpServer());
    await openFeature(testApp, 'registration');
    await openFeature(testApp, 'kyc');
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('la situation du compte reste lisible ; tout le reste répond SERVICE_UNAVAILABLE, sans rien écrire', async () => {
    expect(testApp.config.kyc).toBeNull();
    const user = await registerVerifiedUser(http, testApp);
    const session = await login(http, user);
    const auth = bearer(session.tokens.accessToken);
    const prisma = testApp.app.get(PrismaService);

    const overview = kycOverviewSchema.parse(
      (await http.get('/api/v1/me/verification').set(auth).expect(200)).body,
    );
    expect(overview.level).toBe(0);
    const me = currentUserSchema.parse((await http.get('/api/v1/me').set(auth).expect(200)).body);
    expect(me.verificationLevel).toBe(0);

    for (const response of [
      await http.put('/api/v1/me/verification/identity').set(auth).send(identityDeclaration()),
      await http.put('/api/v1/me/verification/address').set(auth).send(addressDeclaration()),
      await http.put('/api/v1/me/verification/source-of-funds').set(auth).send(fundsDeclaration()),
      await http.get(`/api/v1/me/verification/cases/${UNKNOWN_ID}`).set(auth),
      await http
        .post(`/api/v1/me/verification/cases/${UNKNOWN_ID}/documents?kind=SELFIE`)
        .set(auth)
        .set('Content-Type', 'image/jpeg')
        .send(jpeg('sans stockage').content),
      await http
        .delete(`/api/v1/me/verification/cases/${UNKNOWN_ID}/documents/${UNKNOWN_ID}`)
        .set(auth),
      await http.post(`/api/v1/me/verification/cases/${UNKNOWN_ID}/submit`).set(auth),
      await http.delete(`/api/v1/me/verification/cases/${UNKNOWN_ID}`).set(auth),
    ]) {
      expect(response.status).toBe(503);
      expect(problemDetailsSchema.parse(response.body).code).toBe('SERVICE_UNAVAILABLE');
      expect(response.body.detail).toMatch(/document storage is not configured/);
    }
    expect(await prisma.kycCase.count()).toBe(0);

    // Côté personnel : la file se lit (elle est vide), un dossier ne s'ouvre pas.
    const officer = await registerVerifiedUser(http, testApp, { email: newEmail('compliance') });
    const first = await login(http, officer);
    await withOwner(testApp, async (owner) => {
      const role = await owner.role.findUniqueOrThrow({ where: { key: 'compliance' } });
      await owner.userRole.create({ data: { userId: first.user.id, roleId: role.id } });
    });
    const totpSecret = await enableSecondFactor(testApp, {
      id: first.user.id,
      password: officer.password,
    });
    const staffAuth = bearer((await login(http, { ...officer, totpSecret })).tokens.accessToken);
    const queue = adminKycCaseListSchema.parse(
      (await http.get('/api/v1/admin/kyc/cases').set(staffAuth).expect(200)).body,
    );
    expect(queue).toEqual({ cases: [], nextCursor: null });
    for (const response of [
      await http.get(`/api/v1/admin/kyc/cases/${UNKNOWN_ID}`).set(staffAuth),
      await http
        .get(`/api/v1/admin/kyc/cases/${UNKNOWN_ID}/documents/${UNKNOWN_ID}`)
        .set(staffAuth),
      await http.post(`/api/v1/admin/kyc/cases/${UNKNOWN_ID}/approve`).set(staffAuth),
    ]) {
      expect(response.status).toBe(503);
    }

    // La purge périodique s'exécute sans toucher à aucun dossier ni à aucun compte.
    const report = await testApp.app.get(AccountMaintenanceService).run();
    expect(report.failures).toBe(0);
    expect(Object.keys(report.otherSteps).sort()).toEqual([
      'erase-closed-accounts',
      'purge-published-events',
      'purge-stale-kyc-drafts',
      'verify-ledger',
    ]);
    expect(report.otherSteps).toMatchObject({
      'purge-stale-kyc-drafts': 0,
      'erase-closed-accounts': 0,
    });
  });

  it('un compte qui avait déclaré une pièce n’obtient pas la copie de ses données, mais peut se clore', async () => {
    const prisma = testApp.app.get(PrismaService);
    const user = await registerVerifiedUser(http, testApp);
    const session = await login(http, user);
    const auth = bearer(session.tokens.accessToken);
    // Un dossier reçu lorsque le stockage était encore configuré, avec une pièce.
    const caseId = await withConnection(testApp.database.appUrl, async (db) => {
      const id = await insertCase(db, session.user.id, 1);
      await addDocument(db, id, 'IDENTITY_FRONT');
      return id;
    });

    // Le numéro de la pièce, chiffré, ne peut pas être relu : pas de copie tronquée en silence.
    const refused = await http
      .post('/api/v1/me/data-export')
      .set(auth)
      .send({ currentPassword: user.password })
      .expect(503);
    expect(problemDetailsSchema.parse(refused.body).code).toBe('SERVICE_UNAVAILABLE');
    expect(
      await prisma.auditLog.count({
        where: { action: 'user.data_exported', resourceId: session.user.id },
      }),
    ).toBe(0);

    // La clôture reste possible : le dossier jamais déposé disparaît avec la ligne de sa pièce.
    await http
      .post('/api/v1/me/close')
      .set(auth)
      .send({ currentPassword: user.password, confirm: true })
      .expect(200);
    expect(await prisma.kycCase.count({ where: { id: caseId } })).toBe(0);
    expect(await prisma.kycDocument.count({ where: { caseId } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } })).status).toBe(
      'CLOSED',
    );

    // Un compte sans dossier, lui, obtient sa copie.
    const other = await registerVerifiedUser(http, testApp);
    const copy = await http
      .post('/api/v1/me/data-export')
      .set(bearer((await login(http, other)).tokens.accessToken))
      .send({ currentPassword: other.password })
      .expect(200);
    expect(dataExportSchema.parse(copy.body).verification).toEqual({ level: 0, cases: [] });
    await backgroundWorkDone(testApp);
  });
});
