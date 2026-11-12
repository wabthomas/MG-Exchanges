import type {
  KycAddress,
  KycCase,
  KycCaseSummary,
  KycDocument,
  KycFunds,
  KycIdentity,
} from '@mgx/contracts';

import { formatCalendarDate } from '../../identity/domain/profile-policy.js';
import { maskDocumentNumber, missingDocumentKinds } from '../domain/kyc-policy.js';
import type {
  KycAddressRecord,
  KycCaseHeader,
  KycCaseRecord,
  KycDocumentRecord,
  KycFundsRecord,
  KycIdentityRecord,
} from './kyc-case.repository.js';

/** Identité déclarée, sans le numéro de la pièce (rendu masqué au titulaire, complet à la conformité). */
export function identityViewOf(
  identity: KycIdentityRecord,
): Omit<KycIdentity, 'document'> & { document: Omit<KycIdentity['document'], 'numberMasked'> } {
  return {
    givenName: identity.givenName,
    familyName: identity.familyName,
    additionalName: identity.additionalName,
    dateOfBirth: formatCalendarDate(identity.dateOfBirth),
    placeOfBirth: identity.placeOfBirth,
    nationality: identity.nationality,
    document: {
      type: identity.documentType,
      issuingCountry: identity.documentIssuingCountry,
      issuedOn: formatCalendarDate(identity.documentIssuedOn),
      issuedAt: identity.documentIssuedAt,
      expiresOn:
        identity.documentExpiresOn === null ? null : formatCalendarDate(identity.documentExpiresOn),
    },
  };
}

export function addressViewOf(address: KycAddressRecord): KycAddress {
  return {
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    country: address.addressCountry,
    proof: {
      type: address.addressProofType,
      issuedOn: formatCalendarDate(address.addressProofIssuedOn),
    },
  };
}

export function fundsViewOf(funds: KycFundsRecord): KycFunds {
  return {
    sources: [...funds.fundsSources],
    occupation: funds.occupation,
    employerName: funds.employerName,
    explanation: funds.fundsExplanation,
  };
}

export function documentViewOf(document: KycDocumentRecord): KycDocument {
  return {
    id: document.id,
    kind: document.kind,
    contentType: document.contentType,
    byteSize: document.byteSize,
    uploadedAt: document.createdAt.toISOString(),
  };
}

export function caseSummaryOf(header: KycCaseHeader): KycCaseSummary {
  return {
    id: header.id,
    status: header.status,
    submittedAt: header.submittedAt?.toISOString() ?? null,
    decidedAt: header.decidedAt?.toISOString() ?? null,
    rejectionReasons: [...header.rejectionReasons],
  };
}

/**
 * Dossier tel que le voit son titulaire. Il n'y trouve ni la note interne de la décision, ni
 * son auteur, ni le motif d'un retrait ; le numéro de sa pièce lui est rendu masqué.
 */
export function caseViewOf(record: KycCaseRecord, documentNumber: string | null): KycCase {
  const identity =
    record.identity === null || documentNumber === null
      ? null
      : (() => {
          const view = identityViewOf(record.identity);
          return {
            ...view,
            document: { ...view.document, numberMasked: maskDocumentNumber(documentNumber) },
          };
        })();
  return {
    id: record.id,
    level: record.level,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    submittedAt: record.submittedAt?.toISOString() ?? null,
    decidedAt: record.decidedAt?.toISOString() ?? null,
    rejectionReasons: [...record.rejectionReasons],
    endedAt: record.endedAt?.toISOString() ?? null,
    identity,
    address: record.address === null ? null : addressViewOf(record.address),
    sourceOfFunds: record.funds === null ? null : fundsViewOf(record.funds),
    documents: record.documents.map(documentViewOf),
    missingDocuments:
      record.status === 'DRAFT'
        ? missingDocumentKinds(
            record.level,
            record.identity?.documentType ?? null,
            record.documents.map(({ kind }) => kind),
          )
        : [],
  };
}
