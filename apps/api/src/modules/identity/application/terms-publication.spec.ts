import { describe, expect, it } from '@jest/globals';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { AuditService } from '../../audit/application/audit.service.js';
import { publishTermsVersion, sha256OfText } from './terms-publication.js';
import type { NewTermsVersion, TermsRepository, TermsVersionRecord } from './terms.repository.js';
import { toAccountTerms, translateRefusal } from './terms.service.js';
import { TermsRuleViolationError, TermsVersionOutOfSequenceError } from './terms.repository.js';

const tx = {} as DbClient;
const PUBLISHED_AT = new Date('2026-11-13T08:00:00.000Z');
const CLIENT = { requestId: 'req-1', ipAddress: '198.51.100.7', userAgent: 'jest' };
const STAFF_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

function fakes(): {
  terms: TermsRepository;
  audit: AuditService;
  published: NewTermsVersion[];
  recorded: unknown[];
} {
  const published: NewTermsVersion[] = [];
  const recorded: unknown[] = [];
  const terms = {
    publish: (_tx: DbClient, version: NewTermsVersion): Promise<TermsVersionRecord> => {
      published.push(version);
      return Promise.resolve({ ...version, publishedAt: PUBLISHED_AT });
    },
  } as unknown as TermsRepository;
  const audit = {
    record: (_tx: DbClient, entry: unknown): Promise<void> => {
      recorded.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditService;
  return { terms, audit, published, recorded };
}

describe('empreinte d’un texte', () => {
  it('SHA-256 du texte encodé en UTF-8, en hexadécimal minuscule', () => {
    // Vecteur de référence (FIPS 180-2), puis un texte accentué dont l'empreinte a été
    // calculée hors de l'application (`sha256sum`).
    expect(sha256OfText('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256OfText('Arrêté n° 1 — « œuvre » 😀')).toBe(
      'd82f86db6dafdb83ed16fd60aa58b3d504838d0cce026400d18b5b234ed43846',
    );
  });

  it('un octet de différence — fin de ligne, espace final — change l’empreinte', () => {
    const digests = ['Article 1\n', 'Article 1\r\n', 'Article 1', 'Article 1 \n'].map(sha256OfText);
    expect(new Set(digests).size).toBe(4);
  });
});

describe('publication d’une version', () => {
  const fr = { summary: 'Résumé.', body: 'Texte français.\n' };
  const en = { summary: 'Summary.', body: 'English text.\n' };

  it('par un membre du personnel : il en est l’auteur, et l’acte porte le contexte de sa requête', async () => {
    const { terms, audit, published, recorded } = fakes();
    const version = await publishTermsVersion(
      tx,
      { terms, audit },
      { number: 4, requiresAcceptance: true, reason: 'Validée par le conseil', fr, en },
      { kind: 'STAFF', userId: STAFF_ID, client: CLIENT },
    );

    expect(published).toEqual([
      {
        number: 4,
        requiresAcceptance: true,
        publishedBy: STAFF_ID,
        fr: { ...fr, sha256: sha256OfText(fr.body) },
        en: { ...en, sha256: sha256OfText(en.body) },
      },
    ]);
    expect(version.publishedAt).toBe(PUBLISHED_AT);
    expect(recorded).toEqual([
      {
        actor: { type: 'USER', id: STAFF_ID },
        action: 'terms.version_published',
        resource: { type: 'terms_version', id: '4' },
        outcome: 'SUCCESS',
        ...CLIENT,
        // La justification et les empreintes — jamais les textes.
        metadata: {
          requiresAcceptance: true,
          reason: 'Validée par le conseil',
          fr: { sha256: sha256OfText(fr.body) },
          en: { sha256: sha256OfText(en.body) },
        },
      },
    ]);
    expect(JSON.stringify(recorded)).not.toContain('Texte français');
  });

  it('par l’outil d’exploitation : sans auteur, attribuée à la plateforme, origine notée', async () => {
    const { terms, audit, published, recorded } = fakes();
    await publishTermsVersion(
      tx,
      { terms, audit },
      { number: 2, requiresAcceptance: false, reason: 'Correction de forme', fr },
      { kind: 'OPERATOR' },
    );

    // La règle de la version — ici « pour information » — est transmise telle quelle.
    expect(published[0]).toMatchObject({
      number: 2,
      requiresAcceptance: false,
      publishedBy: null,
      en: null,
    });
    expect(recorded).toEqual([
      {
        actor: { type: 'SYSTEM' },
        action: 'terms.version_published',
        resource: { type: 'terms_version', id: '2' },
        outcome: 'SUCCESS',
        metadata: {
          requiresAcceptance: false,
          reason: 'Correction de forme',
          fr: { sha256: sha256OfText(fr.body) },
          en: null,
          origin: 'command-line',
        },
      },
    ]);
  });

  it('un refus de la base n’est pas inscrit au journal comme une publication', async () => {
    const { audit, recorded } = fakes();
    const terms = {
      publish: () => Promise.reject(new TermsVersionOutOfSequenceError()),
    } as unknown as TermsRepository;
    await expect(
      publishTermsVersion(
        tx,
        { terms, audit },
        { number: 9, requiresAcceptance: false, reason: 'Trop tard', fr },
        { kind: 'OPERATOR' },
      ),
    ).rejects.toBeInstanceOf(TermsVersionOutOfSequenceError);
    expect(recorded).toEqual([]);
  });
});

describe('où en est un compte', () => {
  const acceptedAt = new Date('2026-11-13T09:30:00.000Z');
  const current = { number: 3, publishedAt: PUBLISHED_AT, requiresAcceptance: true };

  it.each([
    [
      'rien n’est publié',
      { accountOpen: true, current: null, latestRequired: null, lastAccepted: null },
      null,
      false,
    ],
    [
      'rien accepté, la version 1 l’exige',
      { accountOpen: true, current, latestRequired: 1, lastAccepted: null },
      null,
      true,
    ],
    [
      'version exigée acceptée',
      {
        accountOpen: true,
        current,
        latestRequired: 3,
        lastAccepted: { versionNumber: 3, acceptedAt },
      },
      3,
      false,
    ],
    [
      'version antérieure acceptée',
      {
        accountOpen: true,
        current,
        latestRequired: 3,
        lastAccepted: { versionNumber: 2, acceptedAt },
      },
      2,
      true,
    ],
    [
      'version ultérieure acceptée',
      {
        accountOpen: true,
        current,
        latestRequired: 3,
        lastAccepted: { versionNumber: 4, acceptedAt },
      },
      4,
      false,
    ],
    // Un compte clôturé n'a plus rien à accepter, quoi que disent les versions.
    [
      'compte clôturé',
      { accountOpen: false, current, latestRequired: 3, lastAccepted: null },
      null,
      false,
    ],
    [
      'compte clôturé (acceptation résiduelle)',
      {
        accountOpen: false,
        current,
        latestRequired: 3,
        lastAccepted: { versionNumber: 1, acceptedAt },
      },
      1,
      false,
    ],
  ] as const)('%s', (_label, standing, accepted, acceptanceRequired) => {
    expect(toAccountTerms(standing)).toEqual({
      accepted:
        accepted === null ? null : { number: accepted, acceptedAt: acceptedAt.toISOString() },
      acceptanceRequired,
    });
  });
});

describe('refus de la base, traduits pour l’API', () => {
  it('numéro qui n’est plus celui en vigueur : 409 TERMS_VERSION_NOT_CURRENT', () => {
    expect(translateRefusal(new TermsVersionOutOfSequenceError())).toMatchObject({
      code: 'TERMS_VERSION_NOT_CURRENT',
    });
  });

  it('règle enfreinte (compte suspendu entre-temps) : 409 CONFLICT', () => {
    expect(translateRefusal(new TermsRuleViolationError())).toMatchObject({
      code: 'CONFLICT',
      message: 'The terms of use cannot be accepted by this account.',
    });
  });

  it('toute autre erreur est rendue telle quelle', () => {
    const error = new Error('connection lost');
    expect(translateRefusal(error)).toBe(error);
  });
});
