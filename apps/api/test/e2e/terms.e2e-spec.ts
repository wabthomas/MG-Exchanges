import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  activityListSchema,
  adminTermsVersionListSchema,
  adminTermsVersionSchema,
  adminUserDetailSchema,
  currentUserSchema,
  dataExportSchema,
  problemDetailsSchema,
  TERMS_BODY_MAX_LENGTH,
  TERMS_PUBLICATION_MAX_BYTES,
  termsDocumentSchema,
  termsStatusSchema,
  termsVersionListSchema,
} from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { TermsRepository } from '../../src/modules/identity/application/terms.repository.js';
import { TermsService } from '../../src/modules/identity/application/terms.service.js';
import { SystemSettingsService } from '../../src/modules/system-settings/application/system-settings.service.js';
import {
  backgroundWorkDone,
  bearer,
  codeIn,
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
  PASSWORD,
  type RegisteredUser,
  registerVerifiedUser,
  withOwner,
} from '../support/identity.js';
import { publishTermsAsOperator } from '../support/terms.js';
import { lengthInCharacters } from '../support/terms-sql.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const REASON = 'Version validée par le conseil, courrier du 12 novembre';
const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

/** Empreinte calculée ici, hors de l'application : celle du fichier qu'on a voulu publier. */
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Texte de la version 1 : fins de ligne Windows et Unix mêlées, tabulation, accents, guillemets,
 * émoji, espaces en fin de ligne — tout ce qu'un traitement « bien intentionné » abîmerait. Il
 * dépasse la limite commune des corps de requête (100 kilo-octets).
 */
const V1_FR = `# Conditions d’utilisation\r\n\r\nArticle 1 — Objet.  \n\tAlinéa « œuvre » 😀\n\n${'Clause de remplissage, sans portée. '.repeat(4200)}\nFin.\n`;
const V1_EN = `# Terms of use\n\nArticle 1 — Purpose.\n${'Filler clause, without effect. '.repeat(4200)}\nEnd.\n`;
const V1_SUMMARY_FR = 'Première version des conditions d’utilisation.';
const V1_SUMMARY_EN = 'First version of the terms of use.';

/** Routes d'un titulaire qui restent ouvertes tant qu'il doit accepter la version en vigueur. */
const OPEN_BEFORE_ACCEPTANCE = [
  'GET /api/v1/me',
  'GET /api/v1/me/activity',
  'GET /api/v1/me/mfa',
  'GET /api/v1/me/sessions',
  'GET /api/v1/me/terms',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/password/change',
  'POST /api/v1/me/close',
  'POST /api/v1/me/data-export',
  'POST /api/v1/me/mfa/recovery-codes',
  'POST /api/v1/me/mfa/totp/confirm',
  'POST /api/v1/me/mfa/totp/disable',
  'POST /api/v1/me/mfa/totp/enroll',
  'POST /api/v1/me/sessions/revoke-others',
  'POST /api/v1/me/terms/acceptance',
  'DELETE /api/v1/me/sessions/{sessionId}',
].sort();

/** Routes d'un titulaire fermées tant qu'il doit accepter : tout le reste. */
const CLOSED_BEFORE_ACCEPTANCE = [
  'GET /api/v1/me/profile',
  'PATCH /api/v1/me/profile',
  'POST /api/v1/me/phone/verification',
  'POST /api/v1/me/phone/verify',
  'GET /api/v1/me/verification',
  'PUT /api/v1/me/verification/identity',
  'PUT /api/v1/me/verification/address',
  'PUT /api/v1/me/verification/source-of-funds',
  'GET /api/v1/me/verification/cases/{caseId}',
  'DELETE /api/v1/me/verification/cases/{caseId}',
  'POST /api/v1/me/verification/cases/{caseId}/documents',
  'DELETE /api/v1/me/verification/cases/{caseId}/documents/{documentId}',
  'POST /api/v1/me/verification/cases/{caseId}/submit',
  'GET /api/v1/me/wallets',
  'GET /api/v1/me/wallets/{assetCode}/movements',
].sort();

interface Member extends RegisteredUser {
  readonly id: string;
  readonly accessToken: string;
}

interface Operation {
  readonly id: string;
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  readonly path: string;
}

/**
 * Les scénarios s'enchaînent : une version publiée l'est pour toujours, et chaque étape part de
 * l'état laissé par la précédente — aucune version, puis la 1 (à accepter), la 2 (signalée), la
 * 3 (à accepter), la 4 (signalée)…
 */
describe('Conditions d’utilisation — bout en bout', () => {
  let testApp: TestApp;
  let http: Http;
  let prisma: PrismaService;
  /** Administrateur (rôle super_admin, second facteur activé), créé par l'outil d'amorçage. */
  let root: Member;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { TRUST_PROXY_HOPS: '1' }, terms: 'none' });
    http = request(testApp.app.getHttpServer());
    prisma = testApp.app.get(PrismaService);
    root = await admin();
  });

  afterAll(async () => {
    await testApp.close();
  });

  const get = (accessToken: string, path: string) =>
    http.get(`/api/v1${path}`).set(bearer(accessToken)).set(from(newClientIp()));
  const post = (accessToken: string, path: string, body?: Record<string, unknown>) =>
    http.post(`/api/v1${path}`).set(bearer(accessToken)).set(from(newClientIp())).send(body);
  const read = (path: string) => http.get(`/api/v1${path}`).set(from(newClientIp()));
  const codeOf = (response: { body: unknown }) => problemDetailsSchema.parse(response.body).code;
  const detailOf = (response: { body: unknown }) =>
    problemDetailsSchema.parse(response.body).detail;
  const pathsOf = (response: { body: unknown }) =>
    problemDetailsSchema.parse(response.body).errors?.map((error) => error.path);

  async function admin(options: { secondFactor?: boolean } = {}): Promise<Member> {
    const created = await createAdmin(testApp, options);
    const session = await login(http, created);
    return { ...created, accessToken: session.tokens.accessToken };
  }

  /** Utilisateur final connecté ; il a accepté, en s'inscrivant, la version alors en vigueur. */
  async function customer(): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp);
    const session = await login(http, user);
    return { ...user, id: session.user.id, accessToken: session.tokens.accessToken };
  }

  /** Agent du support : rôle `support`, second facteur activé, connecté. */
  async function supportAgent(): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp, { email: newEmail('support') });
    const first = await login(http, user);
    await withOwner(testApp, async (owner) => {
      const role = await owner.role.findUniqueOrThrow({ where: { key: 'support' } });
      await owner.userRole.create({ data: { userId: first.user.id, roleId: role.id } });
    });
    const totpSecret = await enableSecondFactor(testApp, {
      id: first.user.id,
      password: user.password,
    });
    const session = await login(http, { ...user, totpSecret });
    return { ...user, totpSecret, id: first.user.id, accessToken: session.tokens.accessToken };
  }

  const currentNumber = async (): Promise<number> =>
    (await prisma.termsVersion.aggregate({ _max: { number: true } }))._max.number ?? 0;

  /** Publication valide de la version suivante ; `overrides` en remplace les champs. */
  async function publication(
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const number = (await currentNumber()) + 1;
    return {
      number,
      requiresAcceptance: true,
      reason: REASON,
      fr: {
        summary: `Version ${String(number)} : ce qui change.`,
        body: `# Conditions d’utilisation\n\nVersion ${String(number)}.\n`,
      },
      ...overrides,
    };
  }

  const publish = (author: Member, body: Record<string, unknown>) =>
    post(author.accessToken, '/admin/terms/versions', body);

  /** Publie la version suivante par le back-office ; rend son numéro. */
  async function published(overrides: Record<string, unknown> = {}): Promise<number> {
    const response = await publish(root, await publication(overrides)).expect(201);
    return adminTermsVersionSchema.parse(response.body).number;
  }

  const statusOf = async (member: Member) =>
    termsStatusSchema.parse((await get(member.accessToken, '/me/terms').expect(200)).body);

  const accept = (member: Member, version: number) =>
    post(member.accessToken, '/me/terms/acceptance', { version });

  const acceptancesOf = async (userId: string): Promise<number[]> =>
    (
      await prisma.termsAcceptance.findMany({
        where: { userId },
        orderBy: { versionNumber: 'asc' },
        select: { versionNumber: true },
      })
    ).map(({ versionNumber }) => versionNumber);

  const auditOf = (action: string, resourceId: string) =>
    prisma.auditLog.findMany({
      where: { action, resourceId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });

  const register = (body: Record<string, unknown>) =>
    http.post('/api/v1/auth/register').set(from(newClientIp())).send(body);

  // ---------------------------------------------------------------------------------------------
  describe('tant qu’aucune version n’est publiée', () => {
    it('il n’y a rien à lire', async () => {
      const current = await read('/terms/current').expect(404);
      expect(codeOf(current)).toBe('NOT_FOUND');
      expect(detailOf(current)).toBe('No terms of use have been published yet.');
      expect(codeOf(await read('/terms/versions/1').expect(404))).toBe('NOT_FOUND');
      expect(
        termsVersionListSchema.parse((await read('/terms/versions').expect(200)).body),
      ).toEqual({ versions: [] });
      expect(
        adminTermsVersionListSchema.parse(
          (await get(root.accessToken, '/admin/terms/versions').expect(200)).body,
        ),
      ).toEqual({ versions: [] });
    });

    it('rien n’est exigé d’un compte : ses routes lui restent ouvertes', async () => {
      expect(await statusOf(root)).toEqual({
        current: null,
        accepted: null,
        acceptanceRequired: false,
      });
      const me = currentUserSchema.parse((await get(root.accessToken, '/me').expect(200)).body);
      expect(me.termsAcceptanceRequired).toBe(false);
      await get(root.accessToken, '/me/profile').expect(200);

      // Et il n'y a rien à accepter.
      for (const version of [1, 2]) {
        expect(codeOf(await accept(root, version).expect(409))).toBe('TERMS_VERSION_NOT_CURRENT');
      }
      expect(await acceptancesOf(root.id)).toEqual([]);
    });

    it('personne ne s’inscrit : on n’ouvre pas de compte sans texte à accepter', async () => {
      await openFeature(testApp, 'registration');
      const email = newEmail();
      for (const acceptedTermsVersion of [1, 2]) {
        const refused = await register({
          email,
          password: PASSWORD,
          countryCode: 'CD',
          acceptedTermsVersion,
        }).expect(503);
        expect(codeOf(refused)).toBe('SERVICE_UNAVAILABLE');
        expect(detailOf(refused)).toBe(
          'Registration is not available yet: the terms of use have not been published.',
        );
      }
      expect(await prisma.user.count({ where: { email } })).toBe(0);
      await backgroundWorkDone(testApp);
      expect(mailbox(testApp).messagesFor(email)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('publier la première version', () => {
    const v1 = {
      number: 1,
      requiresAcceptance: true,
      reason: REASON,
      fr: { summary: V1_SUMMARY_FR, body: V1_FR },
      en: { summary: V1_SUMMARY_EN, body: V1_EN },
    };

    it('exige un compte du personnel, la validation en deux étapes et la permission', async () => {
      const anonymous = await http
        .post('/api/v1/admin/terms/versions')
        .set(from(newClientIp()))
        .send(v1)
        .expect(401);
      expect(codeOf(anonymous)).toBe('UNAUTHENTICATED');

      const unprotected = await admin({ secondFactor: false });
      expect(codeOf(await publish(unprotected, v1).expect(403))).toBe('MFA_ENROLLMENT_REQUIRED');
      expect(codeOf(await get(unprotected.accessToken, '/admin/terms/versions').expect(403))).toBe(
        'MFA_ENROLLMENT_REQUIRED',
      );
      expect(await currentNumber()).toBe(0);
    });

    it('la première version porte le numéro 1 et s’impose à tous', async () => {
      const outOfSequence = await publish(root, { ...v1, number: 2 }).expect(409);
      expect(codeOf(outOfSequence)).toBe('CONFLICT');
      expect(detailOf(outOfSequence)).toBe('Version 2 cannot be published: the next version is 1.');

      const informative = await publish(root, { ...v1, requiresAcceptance: false }).expect(400);
      expect(codeOf(informative)).toBe('VALIDATION_FAILED');
      expect(pathsOf(informative)).toEqual(['requiresAcceptance']);
      expect(await currentNumber()).toBe(0);
    });

    it.each([
      ['numéro absent', { number: undefined }, 'number'],
      ['numéro nul', { number: 0 }, 'number'],
      ['numéro en toutes lettres', { number: '1' }, 'number'],
      ['règle absente', { requiresAcceptance: undefined }, 'requiresAcceptance'],
      ['règle qui n’est pas un booléen', { requiresAcceptance: 'yes' }, 'requiresAcceptance'],
      ['justification absente', { reason: undefined }, 'reason'],
      ['justification trop brève', { reason: 'ok' }, 'reason'],
      ['texte français absent', { fr: undefined }, 'fr'],
      ['texte sans résumé', { fr: { body: V1_FR } }, 'fr.summary'],
      ['résumé sans texte', { fr: { summary: V1_SUMMARY_FR } }, 'fr.body'],
      ['texte vide', { fr: { summary: V1_SUMMARY_FR, body: '' } }, 'fr.body'],
      ['texte fait d’espaces', { fr: { summary: V1_SUMMARY_FR, body: ' \n\t\n ' } }, 'fr.body'],
      [
        'caractère de contrôle',
        { fr: { summary: V1_SUMMARY_FR, body: 'Article\u001b[2J 1' } },
        'fr.body',
      ],
      [
        'marque d’ordre des octets en tête',
        { fr: { summary: V1_SUMMARY_FR, body: `\ufeff${V1_FR}` } },
        'fr.body',
      ],
      [
        'texte d’un caractère de trop',
        { fr: { summary: V1_SUMMARY_FR, body: 't'.repeat(TERMS_BODY_MAX_LENGTH + 1) } },
        'fr.body',
      ],
      ['résumé trop long', { fr: { summary: 'r'.repeat(1001), body: V1_FR } }, 'fr.summary'],
      ['traduction incomplète', { en: { summary: V1_SUMMARY_EN } }, 'en.body'],
      ['traduction nulle', { en: null }, 'en'],
      ['langue inconnue', { sw: { summary: 'Muhtasari', body: 'Masharti' } }, ''],
      // L'annonce par e-mail n'existe pas : la demander est une erreur, pas un oubli silencieux.
      ['option inconnue', { notifyHolders: true }, ''],
      ['date de publication imposée', { publishedAt: '2026-01-01T00:00:00.000Z' }, ''],
    ])('%s : 400, champ désigné, rien de publié', async (_label, overrides, field) => {
      const refused = await publish(root, { ...v1, ...overrides }).expect(400);
      expect(codeOf(refused)).toBe('VALIDATION_FAILED');
      expect(pathsOf(refused)).toContain(field);
      expect(await currentNumber()).toBe(0);
    });

    it('le corps est du JSON, en UTF-8 valide, d’un mébioctet au plus', async () => {
      const raw = (contentType: string, body: Buffer | string) =>
        http
          .post('/api/v1/admin/terms/versions')
          .set(bearer(root.accessToken))
          .set(from(newClientIp()))
          .set('Content-Type', contentType)
          .send(body);

      expect(codeOf(await raw('text/plain', JSON.stringify(v1)).expect(415))).toBe(
        'UNSUPPORTED_MEDIA_TYPE',
      );
      expect(codeOf(await raw('application/json', '{"number": 1,').expect(400))).toBe(
        'MALFORMED_REQUEST',
      );
      expect(codeOf(await raw('application/json', '').expect(400))).toBe('MALFORMED_REQUEST');

      // Un fichier enregistré en Latin-1 : « é » y est l'octet E9, invalide en UTF-8. Il est
      // refusé, plutôt que publié avec un caractère de remplacement.
      const accented = JSON.stringify({
        number: 2,
        requiresAcceptance: true,
        reason: REASON,
        fr: { summary: 'Arr\u00eat\u00e9 du 12 novembre.', body: 'Arr\u00eat\u00e9.\n' },
      });
      const latin1 = Buffer.from(accented, 'latin1');
      expect(latin1.includes(0xe9)).toBe(true);
      const misencoded = await raw('application/json', latin1)
        // Les octets partent tels quels : sans cela, le client de test les réécrirait en JSON.
        .serialize((bytes: Buffer) => bytes as unknown as string)
        .expect(400);
      expect(codeOf(misencoded)).toBe('MALFORMED_REQUEST');
      // Le même contenu en UTF-8 est lu et compris — et refusé pour une autre raison, son
      // numéro : seul l'encodage était en cause.
      expect(codeOf(await raw('application/json', accented).expect(409))).toBe('CONFLICT');

      // À la limite exacte, le corps est lu — et refusé pour une autre raison, la longueur du
      // texte. Un octet de plus : il ne l'est pas.
      expect(TERMS_PUBLICATION_MAX_BYTES).toBe(1_048_576);
      const sized = (bytes: number): string => {
        const envelope = { ...v1, fr: { summary: V1_SUMMARY_FR, body: '' } };
        const filler = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(envelope)));
        const body = JSON.stringify({ ...envelope, fr: { ...envelope.fr, body: filler } });
        expect(Buffer.byteLength(body)).toBe(bytes);
        return body;
      };
      const atLimit = await raw('application/json', sized(1_048_576)).expect(400);
      expect(codeOf(atLimit)).toBe('VALIDATION_FAILED');
      expect(pathsOf(atLimit)).toEqual(['fr.body']);
      const refused = await raw('application/json', sized(1_048_577)).expect(413);
      expect(codeOf(refused)).toBe('PAYLOAD_TOO_LARGE');
      expect(detailOf(refused)).toBe('The request body exceeds the limit of 1048576 bytes.');

      expect(await currentNumber()).toBe(0);
    });

    it('la limite commune des corps de requête vaut toujours pour les autres routes', async () => {
      const large = JSON.stringify({ version: 1, padding: 'x'.repeat(200_000) });
      for (const path of ['/api/v1/me/terms/acceptance', '/api/v1/admin/terms/versions/1']) {
        const refused = await http
          .post(path)
          .set(bearer(root.accessToken))
          .set(from(newClientIp()))
          .set('Content-Type', 'application/json')
          .send(large)
          .expect(413);
        expect(codeOf(refused)).toBe('PAYLOAD_TOO_LARGE');
      }
    });

    it('publie : les textes sont conservés à l’octet près, leurs empreintes rendues, l’acte inscrit au journal', async () => {
      // La requête dépasse la limite commune (100 kilo-octets) : cette route lit elle-même son corps.
      expect(Buffer.byteLength(JSON.stringify(v1))).toBeGreaterThan(250_000);
      await backgroundWorkDone(testApp);
      const messagesBefore = mailbox(testApp).messagesFor(root.email).length;
      const ip = newClientIp();
      const response = await http
        .post('/api/v1/admin/terms/versions')
        .set(bearer(root.accessToken))
        .set(from(ip))
        .send(v1)
        .expect(201);
      const version = adminTermsVersionSchema.parse(response.body);
      expect(response.body).toEqual(version);
      expect(version).toEqual({
        number: 1,
        publishedAt: expect.any(String),
        publishedBy: root.id,
        requiresAcceptance: true,
        current: true,
        fr: { summary: V1_SUMMARY_FR, length: lengthInCharacters(V1_FR), sha256: sha256(V1_FR) },
        en: { summary: V1_SUMMARY_EN, length: lengthInCharacters(V1_EN), sha256: sha256(V1_EN) },
        acceptances: 0,
      });
      // La réponse ne répète pas les textes.
      expect(JSON.stringify(response.body).length).toBeLessThan(1000);

      const stored = await prisma.termsVersion.findUniqueOrThrow({ where: { number: 1 } });
      expect(stored.bodyFr).toBe(V1_FR);
      expect(stored.bodyEn).toBe(V1_EN);
      expect(Math.abs(stored.publishedAt.getTime() - Date.now())).toBeLessThan(60_000);
      expect(version.publishedAt).toBe(stored.publishedAt.toISOString());

      const [entry, ...others] = await auditOf('terms.version_published', '1');
      expect(others).toEqual([]);
      expect(entry).toMatchObject({
        actorType: 'USER',
        actorId: root.id,
        resourceType: 'terms_version',
        outcome: 'SUCCESS',
        ipAddress: ip,
      });
      // Le journal garde la preuve — règle, justification, empreintes —, pas les textes.
      expect(entry?.metadata).toEqual({
        requiresAcceptance: true,
        reason: REASON,
        fr: { sha256: sha256(V1_FR) },
        en: { sha256: sha256(V1_EN) },
      });

      // Aucun e-mail n'annonce une publication.
      await backgroundWorkDone(testApp);
      expect(mailbox(testApp).messagesFor(root.email)).toHaveLength(messagesBefore);
    });

    it('une publication ne se rejoue pas : la même requête, renvoyée, est refusée', async () => {
      const replayed = await publish(root, v1).expect(409);
      expect(codeOf(replayed)).toBe('CONFLICT');
      expect(detailOf(replayed)).toBe('Version 1 cannot be published: the next version is 2.');
      expect(await prisma.termsVersion.count()).toBe(1);
      expect(await auditOf('terms.version_published', '1')).toHaveLength(1);
    });

    it('seul le rôle qui détient terms.publish publie ou suit les versions', async () => {
      const agent = await supportAgent();
      const holder = await customer();
      const next = await publication();
      for (const member of [agent, holder]) {
        expect(codeOf(await publish(member, next).expect(403))).toBe('FORBIDDEN');
        expect(codeOf(await get(member.accessToken, '/admin/terms/versions').expect(403))).toBe(
          'FORBIDDEN',
        );
      }
      expect(await currentNumber()).toBe(1);
      // Le refus est inscrit au journal, comme tout refus du back-office.
      expect(
        await prisma.auditLog.count({
          where: { action: 'authorization.denied', actorId: { in: [agent.id, holder.id] } },
        }),
      ).toBe(4);
    });

    it('une variante d’écriture du chemin mène à la même route, avec les mêmes limites', async () => {
      const large = { ...(await publication({ number: 7 })), fr: { summary: 'x', body: V1_FR } };
      for (const path of ['/api/v1/admin/terms/versions/', '/API/V1/Admin/Terms/Versions']) {
        const refused = await http
          .post(path)
          .set(bearer(root.accessToken))
          .set(from(newClientIp()))
          .send(large)
          .expect(409);
        // Refusée pour son numéro : le corps, plus gros que la limite commune, a donc été lu.
        expect(detailOf(refused)).toBe('Version 7 cannot be published: the next version is 2.');
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('lire les conditions', () => {
    it('la version en vigueur se lit sans compte, telle qu’elle a été publiée', async () => {
      const response = await read('/terms/current').expect(200);
      const document = termsDocumentSchema.parse(response.body);
      expect(response.body).toEqual(document);
      expect(document).toEqual({
        number: 1,
        publishedAt: expect.any(String),
        requiresAcceptance: true,
        current: true,
        locales: ['fr', 'en'],
        locale: 'fr',
        summary: V1_SUMMARY_FR,
        body: V1_FR,
        sha256: sha256(V1_FR),
      });
      // Le lecteur peut vérifier lui-même que le texte reçu est celui qui a été publié.
      expect(sha256(document.body)).toBe(document.sha256);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
    });

    it('dans la langue demandée si elle existe ; en français sinon, et la réponse le dit', async () => {
      const english = termsDocumentSchema.parse(
        (await read('/terms/current?locale=en').expect(200)).body,
      );
      expect(english).toMatchObject({
        locale: 'en',
        summary: V1_SUMMARY_EN,
        body: V1_EN,
        sha256: sha256(V1_EN),
      });
      const french = termsDocumentSchema.parse(
        (await read('/terms/current?locale=fr').expect(200)).body,
      );
      expect(french).toMatchObject({ locale: 'fr', body: V1_FR });

      for (const query of [
        '?locale=sw',
        '?locale=',
        '?locale=EN',
        '?lang=en',
        '?locale=en&locale=fr',
      ]) {
        expect({ query, code: codeOf(await read(`/terms/current${query}`).expect(400)) }).toEqual({
          query,
          code: 'VALIDATION_FAILED',
        });
      }
    });

    it('une version se lit par son numéro ; un numéro mal formé est refusé, un numéro inconnu introuvable', async () => {
      const byNumber = termsDocumentSchema.parse(
        (await read('/terms/versions/1').expect(200)).body,
      );
      expect(byNumber).toEqual(
        termsDocumentSchema.parse((await read('/terms/current').expect(200)).body),
      );
      expect(
        termsDocumentSchema.parse((await read('/terms/versions/1?locale=en').expect(200)).body)
          .body,
      ).toBe(V1_EN);

      for (const number of ['2', '999999999']) {
        expect(codeOf(await read(`/terms/versions/${number}`).expect(404))).toBe('NOT_FOUND');
      }
      for (const number of ['0', '01', '-1', '+1', '1.0', '1e0', '0x1', 'one', '1234567890']) {
        const refused = await read(`/terms/versions/${number}`);
        expect({ number, status: refused.status, code: codeOf(refused) }).toEqual({
          number,
          status: 400,
          code: 'VALIDATION_FAILED',
        });
      }
    });

    it('la liste des versions les décrit sans leur texte', async () => {
      const response = await read('/terms/versions?locale=en').expect(200);
      const list = termsVersionListSchema.parse(response.body);
      expect(response.body).toEqual(list);
      expect(list.versions).toEqual([
        {
          number: 1,
          publishedAt: expect.any(String),
          requiresAcceptance: true,
          current: true,
          locales: ['fr', 'en'],
          locale: 'en',
          summary: V1_SUMMARY_EN,
        },
      ]);
    });

    it('au plus 60 lectures par minute et par client', async () => {
      const ip = newClientIp();
      for (let count = 0; count < 60; count += 1) {
        await http.get('/api/v1/terms/versions').set(from(ip)).expect(200);
      }
      const blocked = await http.get('/api/v1/terms/current').set(from(ip)).expect(429);
      expect(codeOf(blocked)).toBe('RATE_LIMITED');
      // La fenêtre est d'une minute.
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
      // Un autre client n'est pas concerné.
      await read('/terms/current').expect(200);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('s’inscrire, c’est accepter la version en vigueur', () => {
    const registration = (email: string, acceptedTermsVersion: unknown) => ({
      email,
      password: PASSWORD,
      countryCode: 'CD',
      acceptedTermsVersion,
    });

    it('la demande désigne la version lue : l’acceptation est enregistrée avec le compte', async () => {
      const email = newEmail();
      const ip = newClientIp();
      await http
        .post('/api/v1/auth/register')
        .set(from(ip))
        .send(registration(email, 1))
        .expect(202);

      const account = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(account.status).toBe('PENDING_VERIFICATION');
      const acceptance = await prisma.termsAcceptance.findMany({ where: { userId: account.id } });
      expect(acceptance).toHaveLength(1);
      expect(acceptance[0]?.versionNumber).toBe(1);
      expect(Math.abs((acceptance[0]?.acceptedAt.getTime() ?? 0) - Date.now())).toBeLessThan(
        60_000,
      );

      // Au journal : la version et l'empreinte de chaque texte qui était en vigueur.
      const [entry, ...others] = await auditOf('terms.accepted', account.id);
      expect(others).toEqual([]);
      expect(entry).toMatchObject({
        actorType: 'USER',
        actorId: account.id,
        resourceType: 'user',
        outcome: 'SUCCESS',
        ipAddress: ip,
      });
      expect(entry?.metadata).toEqual({
        version: 1,
        fr: { sha256: sha256(V1_FR) },
        en: { sha256: sha256(V1_EN) },
      });

      const code = codeIn(await nextMessageOf(testApp, email, 'email_verification_code'));
      await http
        .post('/api/v1/auth/email/verify')
        .set(from(ip))
        .send({ email, code, password: PASSWORD })
        .expect(204);
      const session = await login(http, { email, password: PASSWORD });
      // La réponse de connexion dit d'emblée s'il reste quelque chose à accepter.
      expect(session.user.termsAcceptanceRequired).toBe(false);
      expect(
        await statusOf({
          email,
          password: PASSWORD,
          id: account.id,
          accessToken: session.tokens.accessToken,
        }),
      ).toEqual({
        current: { number: 1, publishedAt: expect.any(String), requiresAcceptance: true },
        accepted: { number: 1, acceptedAt: acceptance[0]?.acceptedAt.toISOString() },
        acceptanceRequired: false,
      });
    });

    it('une autre version que celle en vigueur est refusée — que l’adresse soit connue ou non', async () => {
      const known = await customer();
      const unknown = newEmail();
      for (const email of [unknown, known.email]) {
        for (const version of [2, 3, 999_999_999]) {
          const refused = await register(registration(email, version)).expect(409);
          expect(codeOf(refused)).toBe('TERMS_VERSION_NOT_CURRENT');
          expect(detailOf(refused)).toBe(
            'This is not the version of the terms of use in force. Read the current version, then try again.',
          );
        }
        for (const version of [0, -1, 1.5, '1', null, true]) {
          expect(codeOf(await register(registration(email, version)).expect(400))).toBe(
            'VALIDATION_FAILED',
          );
        }
      }
      // Aucun de ces refus n'a créé de compte, ni touché à celui qui existait.
      expect(await prisma.user.count({ where: { email: unknown } })).toBe(0);
      expect(await acceptancesOf(known.id)).toEqual([1]);
      // Avec la bonne version, une adresse déjà prise reçoit la même réponse qu'une adresse libre.
      await register(registration(known.email, 1)).expect(202);
      expect(await auditOf('terms.accepted', known.id)).toHaveLength(1);
    });

    it('une inscription remplacée ne garde que l’acceptation du dernier demandeur', async () => {
      const email = newEmail();
      await register(registration(email, 1)).expect(202);
      const account = await prisma.user.findUniqueOrThrow({ where: { email } });
      const first = await prisma.termsAcceptance.findFirstOrThrow({
        where: { userId: account.id },
      });

      await register({ ...registration(email, 1), password: 'autre-mot-de-passe-42' }).expect(202);
      const second = await prisma.termsAcceptance.findMany({ where: { userId: account.id } });
      expect(second).toHaveLength(1);
      expect(second[0]?.versionNumber).toBe(1);
      // C'est une nouvelle acceptation : elle porte sa propre date.
      expect(second[0]?.acceptedAt.getTime()).toBeGreaterThan(first.acceptedAt.getTime());
      // Le journal, lui, garde les deux.
      expect(await auditOf('terms.accepted', account.id)).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('une nouvelle version', () => {
    let early: Member;
    let reader: Member;
    let operations: Operation[];

    beforeAll(async () => {
      early = await customer();
      reader = await customer();
      const document = (await http.get('/api/docs-json').expect(200)).body as {
        paths: Record<string, Record<string, { security?: unknown[] }>>;
      };
      operations = Object.entries(document.paths).flatMap(([path, methods]) =>
        Object.entries(methods)
          .filter(([, operation]) => (operation.security ?? []).length > 0)
          .map(([method]) => ({
            id: `${method.toUpperCase()} ${path}`,
            method: method as Operation['method'],
            path: path.replace(/\{[a-zA-Z]+\}/g, UNKNOWN_ID),
          })),
      );
    });

    const call = (member: Member, operation: Operation) =>
      http[operation.method](operation.path)
        .set(bearer(member.accessToken))
        .set(from(newClientIp()))
        .send({});

    it('publiée « pour information », elle n’interrompt personne — et peut être acceptée', async () => {
      const number = await published({ requiresAcceptance: false });
      expect(number).toBe(2);

      expect(await statusOf(early)).toMatchObject({
        current: { number: 2, requiresAcceptance: false },
        accepted: { number: 1 },
        acceptanceRequired: false,
      });
      await get(early.accessToken, '/me/profile').expect(200);
      expect(
        currentUserSchema.parse((await get(early.accessToken, '/me').expect(200)).body)
          .termsAcceptanceRequired,
      ).toBe(false);

      // Sans traduction, la version est servie en français quelle que soit la langue demandée.
      const document = termsDocumentSchema.parse(
        (await read('/terms/current?locale=en').expect(200)).body,
      );
      expect(document).toMatchObject({ number: 2, locales: ['fr'], locale: 'fr', current: true });
      // La version 1 n'est plus en vigueur, et se lit toujours — à l'identique.
      const superseded = termsDocumentSchema.parse(
        (await read('/terms/versions/1').expect(200)).body,
      );
      expect(superseded).toMatchObject({
        number: 1,
        current: false,
        body: V1_FR,
        sha256: sha256(V1_FR),
      });

      // Qui le souhaite l'accepte : `reader` le fait, `early` non.
      const accepted = termsStatusSchema.parse((await accept(reader, 2).expect(200)).body);
      expect(accepted).toMatchObject({ accepted: { number: 2 }, acceptanceRequired: false });
      expect(await acceptancesOf(reader.id)).toEqual([1, 2]);
      expect(await acceptancesOf(early.id)).toEqual([1]);
    });

    it('une inscription accepte la version en vigueur, même publiée « pour information »', async () => {
      const email = newEmail();
      expect(
        codeOf(
          await register({
            email,
            password: PASSWORD,
            countryCode: 'CD',
            acceptedTermsVersion: 1,
          }).expect(409),
        ),
      ).toBe('TERMS_VERSION_NOT_CURRENT');
      await register({
        email,
        password: PASSWORD,
        countryCode: 'CD',
        acceptedTermsVersion: 2,
      }).expect(202);
      const account = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(await acceptancesOf(account.id)).toEqual([2]);
    });

    it('une inscription restée inachevée sous l’ancienne version doit accepter la nouvelle pour être reprise', async () => {
      // Demandée sous la version 2, jamais vérifiée ; puis la version 3 est publiée.
      const email = newEmail();
      await register({
        email,
        password: PASSWORD,
        countryCode: 'CD',
        acceptedTermsVersion: 2,
      }).expect(202);
      const account = await prisma.user.findUniqueOrThrow({ where: { email } });

      const number = await published({ requiresAcceptance: true });
      expect(number).toBe(3);

      await register({
        email,
        password: PASSWORD,
        countryCode: 'CD',
        acceptedTermsVersion: 2,
      }).expect(409);
      expect(await acceptancesOf(account.id)).toEqual([2]);
      await register({
        email,
        password: PASSWORD,
        countryCode: 'CD',
        acceptedTermsVersion: 3,
      }).expect(202);
      // L'acceptation de l'ancien demandeur est remplacée par celle du nouveau.
      expect(await acceptancesOf(account.id)).toEqual([3]);
    });

    it('à accepter : le compte le sait dès la connexion, et sur GET /me', async () => {
      for (const member of [early, reader]) {
        expect(await statusOf(member)).toMatchObject({
          current: { number: 3, requiresAcceptance: true },
          acceptanceRequired: true,
        });
        const me = currentUserSchema.parse((await get(member.accessToken, '/me').expect(200)).body);
        expect(me.termsAcceptanceRequired).toBe(true);
        const session = await login(http, member);
        expect(session.user.termsAcceptanceRequired).toBe(true);
      }
    });

    it('toute route d’un titulaire est soit fermée, soit explicitement laissée ouverte — en ajouter une exige de choisir', () => {
      const holderRoutes = operations
        .filter(({ id }) => !id.includes(' /api/v1/admin/'))
        .map(({ id }) => id)
        .sort();
      expect(holderRoutes).toEqual([...OPEN_BEFORE_ACCEPTANCE, ...CLOSED_BEFORE_ACCEPTANCE].sort());
      expect(OPEN_BEFORE_ACCEPTANCE).toHaveLength(16);
      expect(CLOSED_BEFORE_ACCEPTANCE).toHaveLength(15);
    });

    it('tant qu’il n’a pas accepté, ses routes répondent 403 TERMS_ACCEPTANCE_REQUIRED, avant même de valider la requête', async () => {
      const closed = operations.filter(({ id }) => CLOSED_BEFORE_ACCEPTANCE.includes(id));
      expect(closed).toHaveLength(15);
      for (const operation of closed) {
        const response = await call(early, operation);
        expect({
          route: operation.id,
          status: response.status,
          code: (response.body as { code?: string }).code,
        }).toEqual({ route: operation.id, status: 403, code: 'TERMS_ACCEPTANCE_REQUIRED' });
        expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
        expect(detailOf(response)).toBe(
          'The current version of the terms of use must be accepted before continuing.',
        );
      }
    });

    it('lui restent : son compte, sa sécurité, son historique, ses données, la clôture — et l’acceptation', async () => {
      const open = operations.filter(({ id }) => OPEN_BEFORE_ACCEPTANCE.includes(id));
      expect(open).toHaveLength(16);
      // Sans corps valide, aucune de ces requêtes n'a d'effet ; aucune n'est refusée au titre
      // des conditions d'utilisation. La déconnexion, qui aboutirait, est vérifiée à part.
      for (const operation of open.filter(
        ({ id }) =>
          id !== 'POST /api/v1/auth/logout' && id !== 'POST /api/v1/me/sessions/revoke-others',
      )) {
        const response = await call(early, operation);
        expect({
          route: operation.id,
          refused: [401, 403].includes(response.status),
          code: (response.body as { code?: string }).code ?? null,
        }).toEqual({
          route: operation.id,
          refused: false,
          code: expect.not.stringMatching(/TERMS/),
        });
      }
      await get(early.accessToken, '/me/sessions').expect(200);
      await get(early.accessToken, '/me/activity').expect(200);
      await get(early.accessToken, '/me/mfa').expect(200);
      await post(early.accessToken, '/me/sessions/revoke-others').expect(200);

      // Se déconnecter reste possible, puis se reconnecter.
      const session = await login(http, early);
      await post(session.tokens.accessToken, '/auth/logout').expect(204);
      await get(session.tokens.accessToken, '/me').expect(401);
    });

    it('le back-office n’est pas concerné : le personnel y agit pour la plateforme, non comme client', async () => {
      // `root` n'a jamais rien accepté.
      expect(await statusOf(root)).toMatchObject({ accepted: null, acceptanceRequired: true });
      await get(root.accessToken, '/admin/terms/versions').expect(200);
      await get(root.accessToken, '/admin/users?limit=1').expect(200);
      await get(root.accessToken, '/admin/system-settings').expect(200);
      // Comme client, en revanche, il est logé à la même enseigne.
      expect(codeOf(await get(root.accessToken, '/me/profile').expect(403))).toBe(
        'TERMS_ACCEPTANCE_REQUIRED',
      );
      // Un titulaire sans droit d'administration reçoit, lui, le refus du back-office.
      expect(codeOf(await get(early.accessToken, '/admin/users').expect(403))).toBe('FORBIDDEN');
    });

    it('accepter : la version en vigueur, et elle seule', async () => {
      for (const version of [1, 2, 4]) {
        const refused = await accept(early, version).expect(409);
        expect(codeOf(refused)).toBe('TERMS_VERSION_NOT_CURRENT');
      }
      for (const body of [
        {},
        { version: '3' },
        { version: 3.5 },
        { version: 0 },
        { version: 3, locale: 'fr' },
      ]) {
        expect(
          codeOf(await post(early.accessToken, '/me/terms/acceptance', body).expect(400)),
        ).toBe('VALIDATION_FAILED');
      }
      expect(await acceptancesOf(early.id)).toEqual([1]);
      expect(codeOf(await get(early.accessToken, '/me/profile').expect(403))).toBe(
        'TERMS_ACCEPTANCE_REQUIRED',
      );

      const ip = newClientIp();
      const response = await http
        .post('/api/v1/me/terms/acceptance')
        .set(bearer(early.accessToken))
        .set(from(ip))
        .send({ version: 3 })
        .expect(200);
      const status = termsStatusSchema.parse(response.body);
      expect(response.body).toEqual(status);
      expect(status).toEqual({
        current: { number: 3, publishedAt: expect.any(String), requiresAcceptance: true },
        accepted: { number: 3, acceptedAt: expect.any(String) },
        acceptanceRequired: false,
      });
      expect(await acceptancesOf(early.id)).toEqual([1, 3]);

      // Ses routes lui sont rendues aussitôt.
      await get(early.accessToken, '/me/profile').expect(200);
      expect(
        currentUserSchema.parse((await get(early.accessToken, '/me').expect(200)).body)
          .termsAcceptanceRequired,
      ).toBe(false);

      // Au journal, avec l'empreinte du texte accepté ; et dans l'historique du titulaire.
      const version3 = await prisma.termsVersion.findUniqueOrThrow({ where: { number: 3 } });
      const entries = await auditOf('terms.accepted', early.id);
      expect(entries).toHaveLength(2);
      expect(entries[1]).toMatchObject({ actorId: early.id, outcome: 'SUCCESS', ipAddress: ip });
      expect(entries[1]?.metadata).toEqual({
        version: 3,
        fr: { sha256: sha256(version3.bodyFr) },
        en: null,
      });
      const activity = activityListSchema.parse(
        (await get(early.accessToken, '/me/activity').expect(200)).body,
      );
      expect(activity.entries.filter(({ type }) => type === 'TERMS_ACCEPTED')).toHaveLength(2);
      expect(activity.entries[0]).toMatchObject({
        type: 'TERMS_ACCEPTED',
        outcome: 'SUCCESS',
        ipAddress: ip,
      });
    });

    it('accepter deux fois ne change rien : la première acceptation fait foi', async () => {
      const before = await statusOf(early);
      const again = termsStatusSchema.parse((await accept(early, 3).expect(200)).body);
      expect(again).toEqual(before);
      expect(await acceptancesOf(early.id)).toEqual([1, 3]);
      expect(await auditOf('terms.accepted', early.id)).toHaveLength(2);
    });

    it('qui a accepté une version signalée doit encore accepter celle qui l’exige', async () => {
      // `reader` avait accepté la version 2, publiée « pour information ».
      expect(await statusOf(reader)).toMatchObject({
        accepted: { number: 2 },
        acceptanceRequired: true,
      });
      expect(codeOf(await get(reader.accessToken, '/me/profile').expect(403))).toBe(
        'TERMS_ACCEPTANCE_REQUIRED',
      );
    });

    it('une version signalée, publiée ensuite, ne lève pas l’obligation née de la précédente — l’accepter s’en acquitte', async () => {
      const number = await published({ requiresAcceptance: false });
      expect(number).toBe(4);

      // `early` a accepté la 3 : rien ne lui est demandé.
      expect(await statusOf(early)).toMatchObject({
        current: { number: 4, requiresAcceptance: false },
        accepted: { number: 3 },
        acceptanceRequired: false,
      });
      await get(early.accessToken, '/me/profile').expect(200);

      // `reader` n'a pas accepté la 3 : il reste tenu d'accepter. La 3 n'est plus en vigueur ;
      // c'est la 4 — le texte qu'il peut lire aujourd'hui — qu'il accepte.
      expect(await statusOf(reader)).toMatchObject({
        accepted: { number: 2 },
        acceptanceRequired: true,
      });
      expect(codeOf(await accept(reader, 3).expect(409))).toBe('TERMS_VERSION_NOT_CURRENT');
      const status = termsStatusSchema.parse((await accept(reader, 4).expect(200)).body);
      expect(status).toMatchObject({ accepted: { number: 4 }, acceptanceRequired: false });
      expect(await acceptancesOf(reader.id)).toEqual([1, 2, 4]);
      await get(reader.accessToken, '/me/profile').expect(200);
    });

    it('le suivi du back-office : chaque version, son auteur, ses empreintes, ses acceptations', async () => {
      const response = await get(root.accessToken, '/admin/terms/versions').expect(200);
      const list = adminTermsVersionListSchema.parse(response.body);
      expect(response.body).toEqual(list);
      expect(
        list.versions.map(({ number, current, requiresAcceptance, publishedBy }) => ({
          number,
          current,
          requiresAcceptance,
          publishedBy,
        })),
      ).toEqual([
        { number: 4, current: true, requiresAcceptance: false, publishedBy: root.id },
        { number: 3, current: false, requiresAcceptance: true, publishedBy: root.id },
        { number: 2, current: false, requiresAcceptance: false, publishedBy: root.id },
        { number: 1, current: false, requiresAcceptance: true, publishedBy: root.id },
      ]);
      for (const version of list.versions) {
        const counted = await prisma.termsAcceptance.count({
          where: { versionNumber: version.number },
        });
        expect({ number: version.number, acceptances: version.acceptances }).toEqual({
          number: version.number,
          acceptances: counted,
        });
      }
      // `early` : 1 et 3 ; `reader` : 1, 2 et 4.
      expect(list.versions.find(({ number }) => number === 4)?.acceptances).toBe(1);
      expect(list.versions.find(({ number }) => number === 3)?.acceptances).toBeGreaterThanOrEqual(
        1,
      );
      expect(list.versions.find(({ number }) => number === 1)).toMatchObject({
        fr: { summary: V1_SUMMARY_FR, length: lengthInCharacters(V1_FR), sha256: sha256(V1_FR) },
        en: { summary: V1_SUMMARY_EN, length: lengthInCharacters(V1_EN), sha256: sha256(V1_EN) },
      });
      // Les dates de publication croissent avec les numéros.
      const dates = list.versions.map(({ publishedAt }) => publishedAt);
      expect([...dates].sort().reverse()).toEqual(dates);
    });

    it('la fiche d’un compte, au back-office, dit où il en est', async () => {
      const late = await customer();
      await published({ requiresAcceptance: true });
      const sheet = async (id: string) =>
        adminUserDetailSchema.parse(
          (await get(root.accessToken, `/admin/users/${id}`).expect(200)).body,
        );
      expect((await sheet(late.id)).terms).toEqual({
        accepted: { number: 4, acceptedAt: expect.any(String) },
        acceptanceRequired: true,
      });
      await accept(late, 5).expect(200);
      expect((await sheet(late.id)).terms).toEqual({
        accepted: { number: 5, acceptedAt: expect.any(String) },
        acceptanceRequired: false,
      });
      expect((await sheet(root.id)).terms).toEqual({ accepted: null, acceptanceRequired: true });
      expect(await sheet(late.id)).not.toHaveProperty('termsAcceptedAt');
    });

    it('la version publiée depuis la ligne de commande du serveur n’a pas d’auteur', async () => {
      const version = await publishTermsAsOperator(testApp.database, { requiresAcceptance: false });
      expect(version.number).toBe(6);
      const list = adminTermsVersionListSchema.parse(
        (await get(root.accessToken, '/admin/terms/versions').expect(200)).body,
      );
      expect(list.versions[0]).toMatchObject({ number: 6, current: true, publishedBy: null });
      const [entry] = await auditOf('terms.version_published', '6');
      expect(entry).toMatchObject({ actorType: 'SYSTEM', actorId: null, ipAddress: null });
      expect(entry?.metadata).toMatchObject({ origin: 'command-line', requiresAcceptance: false });
      // Et l'API, qui se connecte avec le rôle applicatif, ne peut pas en faire autant.
      await expect(
        publishTermsAsOperator({ ownerUrl: testApp.database.appUrl }),
      ).rejects.toMatchObject({ name: 'TermsRuleViolationError' });
      expect(await currentNumber()).toBe(6);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('refuser les conditions', () => {
    it('n’empêche ni d’obtenir la copie de ses données, ni de clôturer son compte', async () => {
      const member = await customer();
      const registeredUnder = await currentNumber();
      const required = await published({ requiresAcceptance: true });
      expect(codeOf(await get(member.accessToken, '/me/profile').expect(403))).toBe(
        'TERMS_ACCEPTANCE_REQUIRED',
      );

      const exported = await post(member.accessToken, '/me/data-export', {
        currentPassword: member.password,
      }).expect(200);
      const copy = dataExportSchema.parse(exported.body);
      expect(copy.formatVersion).toBe(3);
      expect(copy.terms).toEqual({
        acceptances: [{ version: registeredUnder, acceptedAt: expect.any(String) }],
      });

      await post(member.accessToken, '/me/close', {
        currentPassword: member.password,
        confirm: true,
      }).expect(200);

      // Le compte clôturé ne garde aucune acceptation ; la preuve reste au journal d'audit.
      expect(await acceptancesOf(member.id)).toEqual([]);
      const entries = await auditOf('terms.accepted', member.id);
      expect(entries.map(({ metadata }) => (metadata as { version: number }).version)).toEqual([
        registeredUnder,
      ]);
      const sheet = adminUserDetailSchema.parse(
        (await get(root.accessToken, `/admin/users/${member.id}`).expect(200)).body,
      );
      expect(sheet.status).toBe('CLOSED');
      // Clôturé, le compte n'a plus rien à accepter : une requête qui croiserait sa clôture
      // n'est pas refusée au titre des conditions d'utilisation.
      expect(sheet.terms).toEqual({ accepted: null, acceptanceRequired: false });
      const terms = testApp.app.get(TermsService);
      expect(await terms.isAcceptanceRequired(member.id)).toBe(false);
      expect(await terms.isAcceptanceRequired(UNKNOWN_ID)).toBe(false);
      expect(await terms.status(member.id)).toMatchObject({
        current: { number: required },
        accepted: null,
        acceptanceRequired: false,
      });
      expect(required).toBe(registeredUnder + 1);
    });

    it('la copie des données liste les acceptations, de la plus récente à la plus ancienne', async () => {
      const member = await customer();
      const first = await currentNumber();
      const second = await published({ requiresAcceptance: true });
      await accept(member, second).expect(200);
      const copy = dataExportSchema.parse(
        (
          await post(member.accessToken, '/me/data-export', {
            currentPassword: member.password,
          }).expect(200)
        ).body,
      );
      expect(copy.terms.acceptances.map(({ version }) => version)).toEqual([second, first]);
      const dates = copy.terms.acceptances.map(({ acceptedAt }) => acceptedAt);
      expect([...dates].sort().reverse()).toEqual(dates);
      // Chaque date est celle que la base conserve.
      const stored = await prisma.termsAcceptance.findMany({
        where: { userId: member.id },
        orderBy: { versionNumber: 'desc' },
      });
      expect(copy.terms.acceptances).toEqual(
        stored.map(({ versionNumber, acceptedAt }) => ({
          version: versionNumber,
          acceptedAt: acceptedAt.toISOString(),
        })),
      );
      // Ni le texte ni son empreinte : la version se relit sur la route publique.
      expect(JSON.stringify(copy.terms)).not.toMatch(/sha256|body|summary/);
    });

    it('un compte suspendu entre-temps n’accepte pas', async () => {
      const member = await customer();
      const required = await published({ requiresAcceptance: true });
      await post(root.accessToken, `/admin/users/${member.id}/suspend`, {
        reason: 'Signalement du service conformité, dossier 2026-0502',
      }).expect(200);
      // Sa session est fermée : la route lui répond 401. Le service, appelé comme le serait une
      // requête arrivée juste avant la suspension, se heurte à la règle de la base.
      await accept(member, required).expect(401);
      await expect(
        testApp.app
          .get(TermsService)
          .accept(
            { userId: member.id, sessionId: UNKNOWN_ID },
            { version: required },
            { requestId: 'test-suspended', ipAddress: undefined, userAgent: undefined },
          ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await acceptancesOf(member.id)).toEqual([required - 1]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('pendant la maintenance', () => {
    it('on lit les conditions, et le back-office publie ; les titulaires attendent', async () => {
      const member = await customer();
      const settings = testApp.app.get(SystemSettingsService);
      const context = { actor: { type: 'SYSTEM' } as const, reason: 'test: maintenance window' };
      await settings.set('maintenance.mode', { enabled: true, message: null }, context);
      try {
        await read('/terms/current').expect(200);
        await read('/terms/versions').expect(200);
        const number = await published({ requiresAcceptance: true });
        await get(root.accessToken, '/admin/terms/versions').expect(200);
        expect(codeOf(await get(member.accessToken, '/me/terms').expect(503))).toBe('MAINTENANCE');
        expect(codeOf(await accept(member, number).expect(503))).toBe('MAINTENANCE');
      } finally {
        await settings.set('maintenance.mode', { enabled: false, message: null }, context);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('écritures simultanées', () => {
    it('deux publications du même numéro : une seule aboutit, l’autre est refusée proprement', async () => {
      const other = await admin();
      for (let round = 0; round < 3; round += 1) {
        const before = await currentNumber();
        const body = await publication();
        const responses = await Promise.all([
          publish(root, { ...body, fr: { summary: 'De root.', body: 'Texte de root.\n' } }),
          publish(other, { ...body, fr: { summary: 'De other.', body: 'Texte de other.\n' } }),
        ]);
        expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
        const refused = responses.find(({ status }) => status === 409);
        expect(codeOf(refused!)).toBe('CONFLICT');
        expect(detailOf(refused!)).toBe(
          `Version ${String(before + 1)} cannot be published: the next version is ${String(before + 2)}.`,
        );
        expect(await currentNumber()).toBe(before + 1);
        // Celle qui a abouti est entière : son texte, son auteur, son entrée au journal.
        const winner = adminTermsVersionSchema.parse(
          responses.find(({ status }) => status === 201)!.body,
        );
        const stored = await prisma.termsVersion.findUniqueOrThrow({
          where: { number: before + 1 },
        });
        expect(stored.publishedBy).toBe(winner.publishedBy);
        expect(stored.bodyFr).toBe(
          winner.publishedBy === root.id ? 'Texte de root.\n' : 'Texte de other.\n',
        );
        expect(await auditOf('terms.version_published', String(before + 1))).toHaveLength(1);
      }
    });

    it('deux acceptations simultanées du même compte : une ligne, une entrée au journal', async () => {
      const member = await customer();
      const number = await published({ requiresAcceptance: true });
      const responses = await Promise.all([
        accept(member, number),
        accept(member, number),
        accept(member, number),
      ]);
      expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
      const bodies = responses.map(({ body }) => termsStatusSchema.parse(body));
      expect(new Set(bodies.map(({ accepted }) => accepted?.acceptedAt)).size).toBe(1);
      expect(await acceptancesOf(member.id)).toEqual([number - 1, number]);
      const entries = await auditOf('terms.accepted', member.id);
      expect(entries.map(({ metadata }) => (metadata as { version: number }).version)).toEqual([
        number - 1,
        number,
      ]);
    });

    it('une acceptation qui croise une publication aboutit, ou est refusée proprement — jamais d’erreur interne', async () => {
      const outcomes = new Set<number>();
      for (let round = 0; round < 6; round += 1) {
        const member = await customer();
        const current = await currentNumber();
        const body = await publication({ requiresAcceptance: true });
        const [acceptance, publicationResponse] = await Promise.all([
          accept(member, current),
          publish(root, body),
        ]);
        expect(publicationResponse.status).toBe(201);
        expect([200, 409]).toContain(acceptance.status);
        outcomes.add(acceptance.status);
        if (acceptance.status === 409) {
          expect(codeOf(acceptance)).toBe('TERMS_VERSION_NOT_CURRENT');
        }
        // Dans les deux cas le compte doit accepter la version publiée, et le peut.
        expect(await statusOf(member)).toMatchObject({ acceptanceRequired: true });
        await accept(member, current + 1).expect(200);
        expect(await statusOf(member)).toMatchObject({
          accepted: { number: current + 1 },
          acceptanceRequired: false,
        });
      }
      expect(outcomes.size).toBeGreaterThanOrEqual(1);
    });

    it('un auteur qui perd son rôle entre le contrôle des droits et l’écriture : la base refuse, rien n’est publié', async () => {
      const author = await admin();
      const repository = testApp.app.get(TermsRepository);
      const publishInDatabase = repository.publish.bind(repository);
      repository.publish = async (tx, version) => {
        repository.publish = publishInDatabase;
        // Les gardes ont admis la requête ; le rôle est retiré avant l'écriture.
        await withOwner(testApp, (owner) =>
          owner.userRole.deleteMany({ where: { userId: author.id } }),
        );
        return publishInDatabase(tx, version);
      };
      const before = await currentNumber();
      try {
        const refused = await publish(author, await publication()).expect(403);
        expect(codeOf(refused)).toBe('FORBIDDEN');
      } finally {
        repository.publish = publishInDatabase;
      }
      expect(await currentNumber()).toBe(before);
      expect(await auditOf('terms.version_published', String(before + 1))).toEqual([]);
      // Son rôle retiré, il n'est plus admis du tout.
      await publish(author, await publication()).expect(403);
      expect(await currentNumber()).toBe(before);
    });

    it('une version publiée pendant l’inscription : la demande est refusée, que l’adresse soit libre, en attente ou déjà prise', async () => {
      const terms = testApp.app.get(TermsService);
      const assertCurrent = terms.assertCurrent.bind(terms);
      /** La prochaine inscription voit une version publiée juste après son premier contrôle. */
      const publishDuringNextRegistration = (): void => {
        terms.assertCurrent = async (versionNumber) => {
          const header = await assertCurrent(versionNumber);
          terms.assertCurrent = assertCurrent;
          await publishTermsAsOperator(testApp.database, { requiresAcceptance: false });
          return header;
        };
      };
      const body = (email: string, acceptedTermsVersion: number) => ({
        email,
        password: PASSWORD,
        countryCode: 'CD',
        acceptedTermsVersion,
      });

      const free = newEmail();
      const pending = newEmail();
      await register(body(pending, await currentNumber())).expect(202);
      const before = await prisma.user.findUniqueOrThrow({
        where: { email: pending },
        include: { credential: true },
      });
      const acceptedBefore = await acceptancesOf(before.id);
      const holder = await customer();
      await backgroundWorkDone(testApp);
      const receivedBefore = mailbox(testApp).messagesFor(holder.email).length;

      try {
        for (const email of [free, pending, holder.email]) {
          const presented = await currentNumber();
          publishDuringNextRegistration();
          const refused = await register({
            ...body(email, presented),
            password: 'autre-mot-de-passe-42',
          }).expect(409);
          expect(codeOf(refused)).toBe('TERMS_VERSION_NOT_CURRENT');
          // La version a bien été publiée pendant la demande, après son premier contrôle.
          expect(await currentNumber()).toBe(presented + 1);
        }
      } finally {
        terms.assertCurrent = assertCurrent;
      }

      // Rien n'a été écrit : ni compte, ni remplacement de l'inscription en attente, ni avis
      // au titulaire de l'adresse déjà prise.
      expect(await prisma.user.count({ where: { email: free } })).toBe(0);
      const after = await prisma.user.findUniqueOrThrow({
        where: { email: pending },
        include: { credential: true },
      });
      expect(after.registeredAt).toEqual(before.registeredAt);
      expect(after.credential?.passwordHash).toBe(before.credential?.passwordHash);
      expect(after.credential?.passwordHash).toEqual(expect.any(String));
      expect(await acceptancesOf(before.id)).toEqual(acceptedBefore);
      expect(await auditOf('user.registration_rejected', holder.id)).toEqual([]);
      await backgroundWorkDone(testApp);
      expect(mailbox(testApp).messagesFor(holder.email)).toHaveLength(receivedBefore);

      // Avec la version désormais en vigueur, la même demande aboutit dans les trois cas.
      for (const email of [free, pending, holder.email]) {
        await register(body(email, await currentNumber())).expect(202);
      }
      expect(await acceptancesOf(before.id)).toEqual([await currentNumber()]);
    });

    it('au plus 20 publications par heure et par client', async () => {
      const ip = newClientIp();
      const attempt = () =>
        http
          .post('/api/v1/admin/terms/versions')
          .set(bearer(root.accessToken))
          .set(from(ip))
          .send({
            number: 999,
            requiresAcceptance: true,
            reason: REASON,
            fr: { summary: 'x', body: 'y' },
          });
      for (let count = 0; count < 20; count += 1) {
        await attempt().expect(409);
      }
      const blocked = await attempt().expect(429);
      expect(codeOf(blocked)).toBe('RATE_LIMITED');
      // La fenêtre est d'une heure.
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(59 * 60);
      expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60 * 60);
    });
  });
});
