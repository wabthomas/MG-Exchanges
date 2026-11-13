import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import { AuditService } from '../../src/modules/audit/application/audit.service.js';
import {
  publishTermsVersion,
  type TermsPublication,
} from '../../src/modules/identity/application/terms-publication.js';
import type { TermsVersionRecord } from '../../src/modules/identity/application/terms.repository.js';
import { PrismaTermsRepository } from '../../src/modules/identity/infrastructure/prisma-terms.repository.js';

/** Texte de la version 1 publiée par défaut dans chaque application de test. */
export const TEST_TERMS_V1 = {
  summary: 'Première version.',
  body: '# Conditions d’utilisation (test)\n\nArticle 1 — Objet.\n',
} as const;

/** SHA-256 de `TEST_TERMS_V1.body`, calculée hors de l'application (`sha256sum`). */
export const TEST_TERMS_V1_SHA256 =
  'a20c2627eddcf99c085b218965249626ab2c3a5a54def5516c1abe351d5dd8e3';

/**
 * Publie une version comme le fait l'outil d'exploitation `terms:publish` : avec le rôle
 * propriétaire de la base, sans auteur. Par défaut, la version suivante, qui exige d'être
 * acceptée, avec un texte propre à son numéro.
 */
export async function publishTermsAsOperator(
  database: { readonly ownerUrl: string },
  publication: Partial<TermsPublication> = {},
): Promise<TermsVersionRecord> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: database.ownerUrl }),
  });
  const terms = new PrismaTermsRepository();
  try {
    const number = publication.number ?? ((await terms.findCurrentHeader(prisma))?.number ?? 0) + 1;
    return await prisma.$transaction((tx) =>
      publishTermsVersion(
        tx,
        { terms, audit: new AuditService() },
        {
          number,
          requiresAcceptance: true,
          reason: 'Publication de test',
          fr:
            number === 1
              ? TEST_TERMS_V1
              : {
                  summary: `Version ${String(number)} : ce qui change.`,
                  body: `# Conditions d’utilisation (test)\n\nVersion ${String(number)}.\n`,
                },
          ...publication,
        },
        { kind: 'OPERATOR' },
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}
