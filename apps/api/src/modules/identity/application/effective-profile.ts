import type { UpdateProfileRequest } from '@mgx/contracts';

import type { ProfileRecord } from './profile.repository.js';
import type { VerificationStatus } from './verification-status.reader.js';

/** Champs du profil établis par la vérification de l'identité (niveau 1). */
export const IDENTITY_PROFILE_FIELDS = [
  'givenName',
  'familyName',
  'additionalName',
  'dateOfBirth',
] as const satisfies readonly (keyof UpdateProfileRequest)[];

/** Champs du profil établis par la vérification de l'adresse (niveau 2). */
export const ADDRESS_PROFILE_FIELDS = [
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postalCode',
] as const satisfies readonly (keyof UpdateProfileRequest)[];

/** Profil tel qu'il vaut : ce qui est vérifié prime sur ce qui est déclaré. */
export interface EffectiveProfile {
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly additionalName: string | null;
  /** Minuit UTC du jour de naissance. */
  readonly dateOfBirth: Date | null;
  readonly placeOfBirth: string | null;
  readonly nationality: string | null;
  readonly identityVerified: boolean;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly addressVerified: boolean;
  readonly timeZone: string | null;
}

/**
 * Compose le profil d'un compte. Une fois l'identité vérifiée, les noms et la naissance sont
 * **ceux du dossier accepté** — y compris lorsqu'un champ y est vide : le profil déclaré n'est
 * plus consulté pour ce bloc. Il en va de même de l'adresse.
 */
export function effectiveProfileOf(
  declared: ProfileRecord | null,
  { identity, address }: VerificationStatus,
): EffectiveProfile {
  return {
    ...(identity ?? {
      givenName: declared?.givenName ?? null,
      familyName: declared?.familyName ?? null,
      additionalName: declared?.additionalName ?? null,
      dateOfBirth: declared?.dateOfBirth ?? null,
      placeOfBirth: null,
      nationality: null,
    }),
    identityVerified: identity !== null,
    ...(address ?? {
      addressLine1: declared?.addressLine1 ?? null,
      addressLine2: declared?.addressLine2 ?? null,
      city: declared?.city ?? null,
      region: declared?.region ?? null,
      postalCode: declared?.postalCode ?? null,
    }),
    addressVerified: address !== null,
    timeZone: declared?.timeZone ?? null,
  };
}

/** Champs d'une demande de modification que la vérification d'identité a figés. */
export function lockedProfileFields(
  request: UpdateProfileRequest,
  { identity, address }: VerificationStatus,
): string[] {
  const locked: readonly string[] = [
    ...(identity === null ? [] : IDENTITY_PROFILE_FIELDS),
    ...(address === null ? [] : ADDRESS_PROFILE_FIELDS),
  ];
  return Object.keys(request)
    .filter((field) => locked.includes(field))
    .sort();
}
