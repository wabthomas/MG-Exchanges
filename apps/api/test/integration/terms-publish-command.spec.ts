import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type pg from 'pg';

import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../../src/cli/cli-io.js';
import { publishTermsCommand, TERMS_PUBLISH_USAGE } from '../../src/cli/terms-publish.command.js';
import { currentTermsNumber, sha256Hex } from '../support/terms-sql.js';
import { createTestDatabase, type TestDatabase, withConnection } from '../support/test-database.js';

const REASON = 'Première version, validée par le conseil';
const FR = '# Conditions d’utilisation\r\n\r\nArticle 1 — Objet.  \n\t« œuvre » 😀\n';
const EN = '# Terms of use\n\nArticle 1 — Purpose.\n';
const BYTE_ORDER_MARK = Buffer.from([0xef, 0xbb, 0xbf]);

interface Outcome {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

describe('Outil d’exploitation — terms:publish', () => {
  let database: TestDatabase;
  let directory: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    directory = mkdtempSync(join(tmpdir(), 'mgx-terms-'));
    writeFileSync(join(directory, 'fr.md'), FR);
    writeFileSync(join(directory, 'en.md'), EN);
  });

  afterAll(async () => {
    rmSync(directory, { recursive: true, force: true });
    await database.drop();
  });

  const asOwner = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(database.ownerUrl, work);

  /** Exécute la commande comme le ferait le terminal, sans lancer de processus. */
  async function run(
    args: readonly string[],
    env: Record<string, string | undefined> = { DATABASE_MIGRATION_URL: database.ownerUrl },
  ): Promise<Outcome> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await publishTermsCommand(args, {
      env,
      cwd: directory,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  /** Options d'une publication valide de la version suivante ; `overrides` en remplace. */
  async function options(overrides: Record<string, string | null> = {}): Promise<string[]> {
    const next = (await asOwner(currentTermsNumber)) + 1;
    const values: Record<string, string | null> = {
      number: String(next),
      'requires-acceptance': 'yes',
      reason: REASON,
      fr: 'fr.md',
      'fr-summary': 'Première version.',
      ...overrides,
    };
    return Object.entries(values).flatMap(([name, value]) =>
      value === null ? [] : [`--${name}`, value],
    );
  }

  const versionCount = (): Promise<number> =>
    asOwner(
      async (db) =>
        (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM terms_versions')).rows[0]!.n,
    );

  const stored = (number: number) =>
    asOwner(
      async (db) =>
        (
          await db.query<{
            requires_acceptance: boolean;
            summary_fr: string;
            body_fr: string;
            body_fr_sha256: string;
            summary_en: string | null;
            body_en: string | null;
            published_by: string | null;
          }>(
            `SELECT requires_acceptance, summary_fr, body_fr, body_fr_sha256, summary_en, body_en,
                    published_by
             FROM terms_versions WHERE number = $1`,
            [number],
          )
        ).rows[0],
    );

  // Les scénarios s'enchaînent : chacun part du numéro laissé par le précédent.

  it('rien n’est publié tant que la demande n’est pas entière : options, fichiers, règles', async () => {
    const file = (name: string, content: Buffer | string): string => {
      writeFileSync(join(directory, name), content);
      return name;
    };
    const refusals: [string, string[], RegExp][] = [
      ['aucune option', [], /^terms:publish --number/],
      ['numéro absent', await options({ number: null }), /^terms:publish --number/],
      ['règle absente', await options({ 'requires-acceptance': null }), /^terms:publish/],
      ['règle ni oui ni non', await options({ 'requires-acceptance': 'maybe' }), /^terms:publish/],
      ['règle écrite « true »', await options({ 'requires-acceptance': 'true' }), /^terms:publish/],
      ['justification absente', await options({ reason: null }), /^terms:publish/],
      ['texte français absent', await options({ fr: null }), /^terms:publish/],
      ['résumé français absent', await options({ 'fr-summary': null }), /^terms:publish/],
      ['traduction sans résumé', await options({ en: 'en.md' }), /^terms:publish/],
      [
        'résumé de traduction sans texte',
        await options({ 'en-summary': 'First.' }),
        /^terms:publish/,
      ],
      ['option inconnue', [...(await options()), '--notify-holders'], /^terms:publish/],
      ['argument en trop', [...(await options()), 'fr.md'], /^terms:publish/],
      ['numéro nul', await options({ number: '0' }), /^number: /],
      ['numéro en toutes lettres', await options({ number: 'one' }), /^number: /],
      ['numéro à zéro de tête', await options({ number: '01' }), /^number: /],
      [
        'première version « pour information »',
        await options({ 'requires-acceptance': 'no' }),
        /^requiresAcceptance: The first version must require acceptance\.$/,
      ],
      ['justification trop brève', await options({ reason: 'ok' }), /^reason: /],
      ['résumé vide', await options({ 'fr-summary': '  ' }), /^fr\.summary: /],
      [
        'fichier introuvable',
        await options({ fr: 'absent.md' }),
        /^absent\.md cannot be read \(looked for /,
      ],
      [
        'dossier au lieu d’un fichier',
        await options({ fr: '.' }),
        /^\. cannot be read \(looked for /,
      ],
      ['fichier vide', await options({ fr: file('empty.md', '') }), /^fr\.body: /],
      ['fichier fait d’espaces', await options({ fr: file('blank.md', ' \n\t\n') }), /^fr\.body: /],
      [
        'caractère de contrôle',
        await options({ fr: file('control.md', 'Article\u001b[2J 1\n') }),
        /^fr\.body: Must be plain text/,
      ],
      [
        'fichier enregistré en Latin-1',
        await options({ fr: file('latin1.md', Buffer.from('Arr\u00eat\u00e9.\n', 'latin1')) }),
        /^latin1\.md is not valid UTF-8 text: save it as UTF-8 and try again\.$/,
      ],
      [
        'fichier enregistré en UTF-16',
        await options({ fr: file('utf16.md', Buffer.from('\ufeffArticle 1\n', 'utf16le')) }),
        /^utf16\.md is not valid UTF-8 text/,
      ],
      [
        'texte d’un caractère de trop',
        await options({ fr: file('long.md', 't'.repeat(200_001)) }),
        /^fr\.body: /,
      ],
      [
        'fichier de plus d’un mébioctet',
        await options({ fr: file('huge.md', 't'.repeat(1_048_577)) }),
        /^huge\.md is larger than 1048576 bytes\.$/,
      ],
      [
        'traduction mal encodée',
        await options({
          en: file('en-latin1.md', Buffer.from('Caf\u00e9\n', 'latin1')),
          'en-summary': 'First.',
        }),
        /^en-latin1\.md is not valid UTF-8 text/,
      ],
    ];
    for (const [label, args, message] of refusals) {
      const outcome = await run(args);
      expect({ label, code: outcome.code, out: outcome.out }).toEqual({
        label,
        code: EXIT_USAGE,
        out: '',
      });
      expect({ label, err: outcome.err }).toEqual({ label, err: expect.stringMatching(message) });
    }
    expect(refusals).toHaveLength(28);
    // Le chemin cherché est nommé : un chemin relatif s'entend depuis le dossier de la commande.
    expect((await run(await options({ fr: 'absent.md' }))).err).toBe(
      `absent.md cannot be read (looked for ${join(directory, 'absent.md')}).`,
    );
    expect(await versionCount()).toBe(0);
    // Le mode d'emploi est celui du module.
    expect((await run([])).err).toBe(TERMS_PUBLISH_USAGE);
  });

  it('la connexion : l’URL du rôle propriétaire, et rien n’en fuit', async () => {
    const args = await options();
    const missing = await run(args, {});
    expect(missing).toEqual({
      code: EXIT_USAGE,
      out: '',
      err: 'DATABASE_MIGRATION_URL is required (schema owner role).',
    });
    expect(await run(args, { DATABASE_MIGRATION_URL: '' })).toEqual(missing);
    expect(await run(args, { DATABASE_MIGRATION_URL: 'mysql://root:secret@db/app' })).toEqual({
      code: EXIT_USAGE,
      out: '',
      err: 'DATABASE_MIGRATION_URL must be a PostgreSQL URL.',
    });

    // Le rôle de l'API n'a pas le droit de publier sans auteur : la base le refuse.
    const asApi = await run(args, { DATABASE_MIGRATION_URL: database.appUrl });
    expect(asApi).toEqual({
      code: EXIT_USAGE,
      out: '',
      err:
        'The database refused the publication: DATABASE_MIGRATION_URL must be the URL of the ' +
        'schema owner role, not the role of the API.',
    });

    // Base injoignable : un échec technique, dont le message ne répète ni l'URL ni le mot de passe.
    const unreachable = await run(args, {
      DATABASE_MIGRATION_URL: 'postgresql://owner:s3cr3t-p4ss@127.0.0.1:9/absent?connect_timeout=2',
    });
    expect(unreachable.code).toBe(EXIT_FAILURE);
    expect(unreachable.out).toBe('');
    expect(unreachable.err).toMatch(/^The version could not be published \(\w+\)\.$/);
    expect(unreachable.err).not.toMatch(/s3cr3t|127\.0\.0\.1|absent/);
    expect(await versionCount()).toBe(0);
  });

  it('publie la version 1 : le fichier à l’octet près, son empreinte affichée, l’acte au journal', async () => {
    const outcome = await run(await options());
    expect(outcome.err).toBe('');
    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.out.split('\n')).toEqual([
      expect.stringMatching(
        /^Terms of use: version 1 published at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/,
      ),
      `  fr  sha256 ${sha256Hex(FR)}`,
      'Every account must accept this version before continuing.',
    ]);
    // La sortie ne répète pas le texte.
    expect(outcome.out).not.toContain('Article 1');

    expect(await stored(1)).toEqual({
      requires_acceptance: true,
      summary_fr: 'Première version.',
      body_fr: FR,
      body_fr_sha256: sha256Hex(FR),
      summary_en: null,
      body_en: null,
      published_by: null,
    });
    const { rows } = await asOwner((db) =>
      db.query<{
        actor_type: string;
        actor_id: string | null;
        resource_type: string;
        outcome: string;
        metadata: unknown;
      }>(
        `SELECT actor_type, actor_id, resource_type, outcome, metadata FROM audit_logs
         WHERE action = 'terms.version_published' AND resource_id = '1'`,
      ),
    );
    expect(rows).toEqual([
      {
        actor_type: 'SYSTEM',
        actor_id: null,
        resource_type: 'terms_version',
        outcome: 'SUCCESS',
        metadata: {
          origin: 'command-line',
          requiresAcceptance: true,
          reason: REASON,
          fr: { sha256: sha256Hex(FR) },
          en: null,
        },
      },
    ]);
  });

  it('une publication ne se rejoue pas ; le numéro attendu est rappelé', async () => {
    for (const number of ['1', '3', '40']) {
      const outcome = await run(await options({ number }));
      expect(outcome).toEqual({
        code: EXIT_USAGE,
        out: '',
        err: `Version ${number} cannot be published: the next version is 2.`,
      });
    }
    expect(await versionCount()).toBe(1);
  });

  it('avec sa traduction, « pour information », par un chemin absolu', async () => {
    const outcome = await run(
      await options({
        'requires-acceptance': 'no',
        fr: join(directory, 'fr.md'),
        en: join(directory, 'en.md'),
        'en-summary': 'Second version.',
      }),
    );
    expect(outcome.err).toBe('');
    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.out.split('\n')).toEqual([
      expect.stringMatching(/^Terms of use: version 2 published at /),
      `  fr  sha256 ${sha256Hex(FR)}`,
      `  en  sha256 ${sha256Hex(EN)}`,
      'Accounts that accepted an earlier version are not asked to accept this one.',
    ]);
    expect(await stored(2)).toMatchObject({
      requires_acceptance: false,
      body_fr: FR,
      summary_en: 'Second version.',
      body_en: EN,
      published_by: null,
    });
  });

  it('la marque d’ordre des octets d’un éditeur n’entre pas dans le texte — et l’opérateur en est averti', async () => {
    writeFileSync(join(directory, 'bom.md'), Buffer.concat([BYTE_ORDER_MARK, Buffer.from(FR)]));
    const outcome = await run(await options({ fr: 'bom.md' }));
    expect(outcome.err).toBe('');
    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.out.split('\n')).toEqual([
      expect.stringMatching(/^Terms of use: version 3 published at /),
      // L'empreinte du texte, sans la marque : celle que calculera quiconque le relit par l'API.
      `  fr  sha256 ${sha256Hex(FR)}`,
      'Every account must accept this version before continuing.',
      'Note: the byte order mark at the start of bom.md is not part of the text and was left ' +
        'out; the digest above is the digest of the text without it.',
    ]);
    const version = await stored(3);
    expect(version?.body_fr).toBe(FR);
    expect(version?.body_fr.startsWith('\ufeff')).toBe(false);
  });

  it('à la longueur maximale exacte, le texte est publié', async () => {
    const body = `${'é'.repeat(199_999)}\n`;
    writeFileSync(join(directory, 'limit.md'), body);
    const outcome = await run(await options({ fr: 'limit.md' }));
    expect(outcome.err).toBe('');
    expect(outcome.code).toBe(EXIT_OK);
    expect((await stored(4))?.body_fr_sha256).toBe(sha256Hex(body));
  });
});
