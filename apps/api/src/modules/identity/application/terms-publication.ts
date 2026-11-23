import { createHash } from 'node:crypto';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { AuditService } from '../../audit/application/audit.service.js';
import type { TermsText } from '../domain/terms-policy.js';
import type { ClientContext } from './client-context.js';
import type { TermsRepository, TermsVersionRecord } from './terms.repository.js';

/** Ce qui est publié : le numéro de la version, sa règle et ses textes. */
export interface TermsPublication {
  readonly number: number;
  readonly requiresAcceptance: boolean;
  /** Justification, conservée dans le journal d'audit. */
  readonly reason: string;
  readonly fr: { readonly summary: string; readonly body: string };
  readonly en?: { readonly summary: string; readonly body: string } | undefined;
}

/** Auteur d'une publication : un membre du personnel, ou l'opérateur du serveur. */
export type TermsPublisher =
  | { readonly kind: 'STAFF'; readonly userId: string; readonly client: ClientContext }
  | { readonly kind: 'OPERATOR' };

export interface TermsPublicationDependencies {
  readonly terms: TermsRepository;
  readonly audit: AuditService;
}

/** Empreinte SHA-256, en hexadécimal, d'un texte encodé en UTF-8. */
export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function withDigest(text: { readonly summary: string; readonly body: string }): TermsText {
  return { summary: text.summary, body: text.body, sha256: sha256OfText(text.body) };
}

/**
 * Publie une version des conditions d'utilisation — **définitivement** — et l'inscrit au
 * journal d'audit, dans la transaction de l'appelant.
 *
 * Deux chemins y mènent : le back-office (un membre du personnel détenant `terms.publish`) et
 * l'outil d'exploitation en ligne de commande, qui se connecte avec le rôle propriétaire de la
 * base. Dans les deux cas la base vérifie elle-même le numéro, le droit de publier et
 * l'empreinte de chaque texte : celle calculée ici, sur le texte reçu, doit être celle du
 * texte qu'elle conserve.
 *
 * @throws TermsVersionOutOfSequenceError si `number` n'est pas celui de la version suivante.
 * @throws TermsRuleViolationError si l'auteur n'a pas le droit de publier.
 */
export async function publishTermsVersion(
  tx: DbClient,
  { terms, audit }: TermsPublicationDependencies,
  publication: TermsPublication,
  publisher: TermsPublisher,
): Promise<TermsVersionRecord> {
  const version = await terms.publish(tx, {
    number: publication.number,
    requiresAcceptance: publication.requiresAcceptance,
    publishedBy: publisher.kind === 'STAFF' ? publisher.userId : null,
    fr: withDigest(publication.fr),
    en: publication.en === undefined ? null : withDigest(publication.en),
  });

  await audit.record(tx, {
    actor: publisher.kind === 'STAFF' ? { type: 'USER', id: publisher.userId } : { type: 'SYSTEM' },
    action: 'terms.version_published',
    resource: { type: 'terms_version', id: String(version.number) },
    outcome: 'SUCCESS',
    ...(publisher.kind === 'STAFF' ? publisher.client : {}),
    metadata: {
      requiresAcceptance: version.requiresAcceptance,
      reason: publication.reason,
      fr: { sha256: version.fr.sha256 },
      en: version.en === null ? null : { sha256: version.en.sha256 },
      ...(publisher.kind === 'OPERATOR' ? { origin: 'command-line' } : {}),
    },
  });
  return version;
}
