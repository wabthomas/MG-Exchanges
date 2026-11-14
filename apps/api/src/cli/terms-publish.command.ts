import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  type PublishTermsVersionRequest,
  publishTermsVersionRequestSchema,
  TERMS_PUBLICATION_MAX_BYTES,
} from '@mgx/contracts';
import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';

import { PrismaClient } from '../generated/prisma/client.js';
import { AuditService } from '../modules/audit/application/audit.service.js';
import { publishTermsVersion } from '../modules/identity/application/terms-publication.js';
import {
  TermsRuleViolationError,
  TermsVersionOutOfSequenceError,
} from '../modules/identity/application/terms.repository.js';
import { PrismaTermsRepository } from '../modules/identity/infrastructure/prisma-terms.repository.js';
import { type CliIo, definedVariables, EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './cli-io.js';

export const TERMS_PUBLISH_USAGE = `terms:publish --number <n> --requires-acceptance <yes|no> --reason <text>
              --fr <file> --fr-summary <text> [--en <file> --en-summary <text>]

  Publishes a version of the terms of use. PERMANENT: a published version is never changed
  nor withdrawn, and it is in force at once.

    --number               the version in force plus one ("1" for the first version)
    --requires-acceptance  "yes": every account must accept this version before continuing;
                           "no": it is only shown as the version in force
                           (the first version always requires acceptance)
    --reason               why this version is published (kept in the audit log)
    --fr, --en             text files, plain text or Markdown, encoded in UTF-8;
                           the French text is mandatory and prevails
    --fr-summary, --en-summary
                           what changes in this version, in a few sentences

  Environment:
    DATABASE_MIGRATION_URL   PostgreSQL URL of the schema owner role (required)

  Example:
    node dist/cli/main.js terms:publish --number 1 --requires-acceptance yes \\
      --reason "First version, approved by counsel" \\
      --fr ./terms-fr.md --fr-summary "Première version."
`;

const OPTIONS = {
  number: { type: 'string' },
  'requires-acceptance': { type: 'string' },
  reason: { type: 'string' },
  fr: { type: 'string' },
  'fr-summary': { type: 'string' },
  en: { type: 'string' },
  'en-summary': { type: 'string' },
} as const;

const environmentSchema = z.object({
  DATABASE_MIGRATION_URL: z
    .string({ error: 'DATABASE_MIGRATION_URL is required (schema owner role).' })
    .regex(/^postgres(ql)?:\/\//, { error: 'DATABASE_MIGRATION_URL must be a PostgreSQL URL.' }),
});

const BYTE_ORDER_MARK = Buffer.from([0xef, 0xbb, 0xbf]);

/** Erreur de l'opérateur : fichier illisible, trop volumineux ou mal encodé. */
class TextFileError extends Error {}

/**
 * Lit un fichier de texte. Il doit être de l'UTF-8 valide : un fichier enregistré dans un
 * autre encodage est refusé, plutôt que publié avec des caractères de remplacement. La marque
 * d'ordre des octets que certains éditeurs placent en tête de fichier n'appartient pas au
 * texte : elle est retirée, et l'opérateur en est averti.
 */
function readTextFile(
  path: string,
  cwd: string,
): { readonly text: string; readonly hadByteOrderMark: boolean } {
  let content: Buffer;
  const absolute = resolve(cwd, path);
  try {
    if (statSync(absolute).size > TERMS_PUBLICATION_MAX_BYTES) {
      throw new TextFileError(
        `${path} is larger than ${String(TERMS_PUBLICATION_MAX_BYTES)} bytes.`,
      );
    }
    content = readFileSync(absolute);
  } catch (error) {
    if (error instanceof TextFileError) {
      throw error;
    }
    // Le chemin cherché est nommé : un chemin relatif s'entend depuis le dossier de la commande.
    throw new TextFileError(`${path} cannot be read (looked for ${absolute}).`);
  }
  try {
    return {
      // Le décodeur retire la marque d'ordre des octets, et refuse toute séquence invalide.
      text: new TextDecoder('utf-8', { fatal: true }).decode(content),
      hadByteOrderMark: content.subarray(0, BYTE_ORDER_MARK.length).equals(BYTE_ORDER_MARK),
    };
  } catch {
    throw new TextFileError(`${path} is not valid UTF-8 text: save it as UTF-8 and try again.`);
  }
}

/**
 * `terms:publish` — publie une version des conditions d'utilisation à partir de fichiers.
 *
 * La commande se connecte avec le **rôle propriétaire** de la base (`DATABASE_MIGRATION_URL`),
 * seul autorisé par la base à publier une version sans auteur : elle sert à installer la
 * première version avant l'ouverture de la plateforme, ou à publier sans passer par le
 * back-office. Elle applique le même contrat que la route `POST /admin/terms/versions` —
 * mêmes bornes, mêmes refus — et la publication est inscrite au journal d'audit.
 *
 * @returns le code de sortie du processus.
 */
export async function publishTermsCommand(args: readonly string[], io: CliIo): Promise<number> {
  const fail = (message: string, code: number): number => {
    io.err(message);
    return code;
  };

  let values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values'];
  try {
    ({ values } = parseArgs({ args: [...args], options: OPTIONS }));
  } catch {
    // Option inconnue, valeur manquante, argument en trop.
    return fail(TERMS_PUBLISH_USAGE, EXIT_USAGE);
  }
  const requiresAcceptance = { yes: true, no: false }[values['requires-acceptance'] ?? ''];
  if (
    values.number === undefined ||
    requiresAcceptance === undefined ||
    values.reason === undefined ||
    values.fr === undefined ||
    values['fr-summary'] === undefined ||
    // La traduction est entière ou absente.
    (values.en === undefined) !== (values['en-summary'] === undefined)
  ) {
    return fail(TERMS_PUBLISH_USAGE, EXIT_USAGE);
  }

  const notes: string[] = [];
  const textOf = (path: string, summary: string): { summary: string; body: string } => {
    const { text, hadByteOrderMark } = readTextFile(path, io.cwd);
    if (hadByteOrderMark) {
      notes.push(
        `Note: the byte order mark at the start of ${path} is not part of the text and was ` +
          'left out; the digest above is the digest of the text without it.',
      );
    }
    return { summary, body: text };
  };

  let publication: PublishTermsVersionRequest;
  try {
    // Le contrat de la route du back-office : mêmes bornes, mêmes refus.
    const parsed = publishTermsVersionRequestSchema.safeParse({
      number: /^[1-9]\d{0,8}$/.test(values.number) ? Number(values.number) : values.number,
      requiresAcceptance,
      reason: values.reason,
      fr: textOf(values.fr, values['fr-summary']),
      ...(values.en === undefined || values['en-summary'] === undefined
        ? {}
        : { en: textOf(values.en, values['en-summary']) }),
    });
    if (!parsed.success) {
      return fail(
        parsed.error.issues
          .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
          .join('\n'),
        EXIT_USAGE,
      );
    }
    publication = parsed.data;
  } catch (error) {
    if (error instanceof TextFileError) {
      return fail(error.message, EXIT_USAGE);
    }
    throw error;
  }

  const environment = environmentSchema.safeParse(definedVariables(io.env));
  if (!environment.success) {
    // Les messages ne contiennent jamais la valeur d'une variable.
    return fail(environment.error.issues.map((issue) => issue.message).join('\n'), EXIT_USAGE);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: environment.data.DATABASE_MIGRATION_URL }),
  });
  const terms = new PrismaTermsRepository();
  try {
    const version = await prisma.$transaction((tx) =>
      publishTermsVersion(tx, { terms, audit: new AuditService() }, publication, {
        kind: 'OPERATOR',
      }),
    );
    io.out(
      [
        `Terms of use: version ${String(version.number)} published at ${version.publishedAt.toISOString()}.`,
        `  fr  sha256 ${version.fr.sha256}`,
        ...(version.en === null ? [] : [`  en  sha256 ${version.en.sha256}`]),
        version.requiresAcceptance
          ? 'Every account must accept this version before continuing.'
          : 'Accounts that accepted an earlier version are not asked to accept this one.',
        ...notes,
      ].join('\n'),
    );
    return EXIT_OK;
  } catch (error) {
    if (error instanceof TermsVersionOutOfSequenceError) {
      const current = await terms.findCurrentHeader(prisma);
      return fail(
        `Version ${String(publication.number)} cannot be published: the next version is ` +
          `${String((current?.number ?? 0) + 1)}.`,
        EXIT_USAGE,
      );
    }
    if (error instanceof TermsRuleViolationError) {
      return fail(
        'The database refused the publication: DATABASE_MIGRATION_URL must be the URL of the ' +
          'schema owner role, not the role of the API.',
        EXIT_USAGE,
      );
    }
    // Ni texte ni URL de connexion dans la sortie : seulement la nature de l'erreur.
    const reason = error instanceof Error ? error.name : 'unknown error';
    return fail(`The version could not be published (${reason}).`, EXIT_FAILURE);
  } finally {
    await prisma.$disconnect();
  }
}
