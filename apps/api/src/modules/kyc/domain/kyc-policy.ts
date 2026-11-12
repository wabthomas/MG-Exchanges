import {
  type FieldError,
  KYC_ADDRESS_PROOF_MAX_AGE_DAYS,
  KYC_DOCUMENT_CONTENT_TYPES,
  KYC_DOCUMENT_KINDS,
  type KycAddressDeclaration,
  type KycDocumentContentType,
  type KycDocumentKind,
  kycDocumentRule,
  type KycIdentityDeclaration,
  type KycIdentityDocumentType,
  type KycLevel,
} from '@mgx/contracts';

import {
  BIRTH_DATE_REJECTION_MESSAGES,
  checkBirthDate,
  parseCalendarDate,
} from '../../identity/domain/profile-policy.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Taille minimale d'une pièce : en dessous, ce n'est ni une photographie ni un document. */
export const KYC_DOCUMENT_MIN_BYTES = 1024;

/** Quota d'une action par compte : au plus `limit` fois par fenêtre de `windowMs`. */
interface Quota {
  readonly limit: number;
  readonly windowMs: number;
}

/** Enregistrements d'un dossier en préparation, par compte. */
export const KYC_DRAFT_SAVES_PER_ACCOUNT: Quota = { limit: 30, windowMs: 60 * MINUTE_MS };

/** Envois de pièces, par compte : chaque envoi est chiffré et écrit sur disque. */
export const KYC_UPLOADS_PER_ACCOUNT: Quota = { limit: 40, windowMs: 60 * MINUTE_MS };

/** Dépôts de dossiers, par compte : chaque dépôt mobilise un examen humain. */
export const KYC_SUBMISSIONS_PER_ACCOUNT: Quota = { limit: 5, windowMs: DAY_MS };

/**
 * Nombre de pièces reçues en même temps par une instance de l'API. Chaque réception garde le
 * fichier en mémoire le temps de le chiffrer : cette borne plafonne la mémoire que les envois
 * peuvent mobiliser, quel que soit le nombre de comptes qui envoient. Au-delà, l'envoi est
 * refusé aussitôt (« réessayez dans quelques secondes »).
 */
export const KYC_UPLOADS_IN_FLIGHT_MAX = 8;

/** Délai proposé au client lorsque toutes les réceptions sont occupées, en secondes. */
export const KYC_UPLOAD_RETRY_AFTER_SECONDS = 5;

/**
 * Pièces qui ne valent pièce d'identité que délivrées par certains pays : la carte d'électeur
 * tient lieu de pièce d'identité en RDC, pas ailleurs.
 */
const ISSUERS_BY_DOCUMENT_TYPE: Partial<Record<KycIdentityDocumentType, readonly string[]>> = {
  VOTER_CARD: ['CD'],
};

/** Jour civil (UTC) d'un instant : `2026-11-12`. Les dates ISO se comparent comme des chaînes. */
export function calendarDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** Ce qu'il faut connaître d'une déclaration d'identité pour la contrôler. */
export interface IdentityFacts {
  readonly dateOfBirth: string;
  readonly document: Pick<
    KycIdentityDeclaration['document'],
    'type' | 'issuingCountry' | 'issuedOn' | 'expiresOn'
  >;
}

/** Ce qu'il faut connaître d'une déclaration d'adresse pour la contrôler. */
export interface AddressFacts {
  readonly country: string;
  readonly proof: Pick<KycAddressDeclaration['proof'], 'issuedOn'>;
}

/**
 * Contrôles d'une déclaration d'identité qui dépendent du jour : âge, validité de la pièce.
 * Ils sont refaits au dépôt — entre l'enregistrement et le dépôt, une pièce peut avoir expiré.
 */
export function checkIdentityDeclaration(declaration: IdentityFacts, now: Date): FieldError[] {
  const errors: FieldError[] = [];
  const today = calendarDay(now);
  const { document } = declaration;

  const birthDateRejection = checkBirthDate(declaration.dateOfBirth, now);
  if (birthDateRejection !== null) {
    errors.push({
      path: 'dateOfBirth',
      message: BIRTH_DATE_REJECTION_MESSAGES[birthDateRejection],
    });
  }

  if (parseCalendarDate(document.issuedOn) === null) {
    errors.push({ path: 'document.issuedOn', message: 'Must be a valid calendar date.' });
  } else if (document.issuedOn > today) {
    errors.push({ path: 'document.issuedOn', message: 'Must not be in the future.' });
  } else if (document.issuedOn < declaration.dateOfBirth) {
    errors.push({ path: 'document.issuedOn', message: 'Must not be before the date of birth.' });
  }

  if (document.expiresOn === null) {
    if (document.type === 'PASSPORT') {
      errors.push({ path: 'document.expiresOn', message: 'Is required for a passport.' });
    }
  } else if (parseCalendarDate(document.expiresOn) === null) {
    errors.push({ path: 'document.expiresOn', message: 'Must be a valid calendar date.' });
  } else if (document.expiresOn <= today) {
    errors.push({
      path: 'document.expiresOn',
      message: 'The document has expired: a valid document is required.',
    });
  } else if (document.expiresOn <= document.issuedOn) {
    errors.push({ path: 'document.expiresOn', message: 'Must be after the date of issue.' });
  }

  const issuers = ISSUERS_BY_DOCUMENT_TYPE[document.type];
  if (issuers !== undefined && !issuers.includes(document.issuingCountry)) {
    errors.push({
      path: 'document.issuingCountry',
      message: `This type of document is only accepted when issued by: ${issuers.join(', ')}.`,
    });
  }
  return errors;
}

/** Contrôles d'une déclaration d'adresse : pays du compte, justificatif récent. */
export function checkAddressDeclaration(
  declaration: AddressFacts,
  accountCountry: string,
  now: Date,
): FieldError[] {
  const errors: FieldError[] = [];
  const today = calendarDay(now);
  const oldest = calendarDay(new Date(now.getTime() - KYC_ADDRESS_PROOF_MAX_AGE_DAYS * DAY_MS));

  if (declaration.country !== accountCountry) {
    errors.push({
      path: 'country',
      message: `Must be the country of residence of the account (${accountCountry}).`,
    });
  }
  if (parseCalendarDate(declaration.proof.issuedOn) === null) {
    errors.push({ path: 'proof.issuedOn', message: 'Must be a valid calendar date.' });
  } else if (declaration.proof.issuedOn > today) {
    errors.push({ path: 'proof.issuedOn', message: 'Must not be in the future.' });
  } else if (declaration.proof.issuedOn < oldest) {
    errors.push({
      path: 'proof.issuedOn',
      message: `The proof of address must be less than ${String(KYC_ADDRESS_PROOF_MAX_AGE_DAYS)} days old.`,
    });
  }
  return errors;
}

/** Pièces qu'il reste à joindre à un dossier pour pouvoir le déposer. */
export function missingDocumentKinds(
  level: KycLevel,
  identityDocumentType: KycIdentityDocumentType | null,
  attached: readonly KycDocumentKind[],
): KycDocumentKind[] {
  return KYC_DOCUMENT_KINDS.filter((kind) => {
    const rule = kycDocumentRule(level, kind, identityDocumentType);
    return rule !== null && attached.filter((present) => present === kind).length < rule.min;
  });
}

const MASK = '••••';

/**
 * Numéro de pièce tel qu'il est rendu à son titulaire : seuls les derniers caractères — au
 * plus trois, jamais plus du tiers — restent lisibles.
 */
export function maskDocumentNumber(number: string): string {
  const visible = Math.min(3, Math.floor(number.length / 3));
  return visible === 0 ? MASK : `${MASK}${number.slice(-visible)}`;
}

/**
 * Format annoncé par l'en-tête `Content-Type` d'un envoi, s'il fait partie des formats
 * acceptés ; `null` sinon. Les paramètres éventuels (`; charset=…`) sont ignorés.
 */
export function acceptedContentType(header: string | undefined): KycDocumentContentType | null {
  const declared = header?.split(';')[0]?.trim().toLowerCase();
  return KYC_DOCUMENT_CONTENT_TYPES.find((type) => type === declared) ?? null;
}
