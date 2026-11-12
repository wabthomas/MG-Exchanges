import { z } from 'zod';

/**
 * Catalogue des permissions du back-office.
 *
 * Une permission est liée au code : chaque route d'administration en exige une ou plusieurs.
 * Le catalogue est recopié dans la table `permissions` par les migrations ; un test vérifie
 * que la base et ce fichier sont identiques. Les utilisateurs finaux n'ont aucune permission :
 * ils n'accèdent qu'à leurs propres données.
 */
export const PERMISSIONS = {
  'system_settings.read': 'View platform settings (maintenance mode, feature availability).',
  'system_settings.write': 'Change platform settings: maintenance mode and opening of features.',
  'users.read': 'Search accounts and view their details.',
  'users.suspend': 'Suspend and reactivate accounts.',
  'users.revoke_sessions': 'Sign an account out of all its devices.',
  'users.reset_mfa': 'Remove the two-step verification of an account that lost its authenticator.',
  'roles.read': 'View roles, their holders and role change requests.',
  'roles.manage': 'Request, approve or reject role changes, and act on staff accounts.',
  'kyc.read': 'View identity verification cases and the documents attached to them.',
  'kyc.review': 'Approve or reject identity verification cases.',
  'kyc.revoke': 'Withdraw an identity verification that was approved.',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as [PermissionKey, ...PermissionKey[]];

export const permissionKeySchema = z.enum(PERMISSION_KEYS);

/** Format d'une clé de permission : `ressource.action`. */
export const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** Format d'une clé de rôle. */
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Rôles système, créés par les migrations et non modifiables. Un test vérifie que la base et
 * ce catalogue sont identiques.
 *
 *  - `super_admin` détient toutes les permissions du catalogue ;
 *  - `support` trouve les comptes, ferme leurs sessions et les suspend. Il ne retire pas un
 *    second facteur, n'agit pas sur les comptes du personnel et ne voit aucune pièce
 *    d'identité ;
 *  - `compliance` examine les dossiers de vérification d'identité : il consulte les pièces,
 *    accepte, refuse, et retire une vérification. Il n'a aucune prise sur les comptes.
 */
export const SYSTEM_ROLES = {
  super_admin: PERMISSION_KEYS,
  support: ['users.read', 'users.suspend', 'users.revoke_sessions'],
  compliance: ['users.read', 'kyc.read', 'kyc.review', 'kyc.revoke'],
} as const satisfies Record<string, readonly PermissionKey[]>;

export type SystemRoleKey = keyof typeof SYSTEM_ROLES;

export const SYSTEM_ROLE_KEYS = Object.keys(SYSTEM_ROLES) as [SystemRoleKey, ...SystemRoleKey[]];

/**
 * Permission qui autorise à demander, approuver ou refuser un changement de rôle — et, plus
 * largement, à agir sur le compte d'un membre du personnel. La base de données la vérifie
 * elle-même lorsqu'un changement de rôle est approuvé.
 */
export const ROLE_MANAGEMENT_PERMISSION = 'roles.manage' satisfies PermissionKey;

/**
 * Permissions de la vérification d'identité que la base de données vérifie elle-même : la
 * première lorsqu'un dossier est accepté ou refusé, la seconde lorsqu'une vérification est
 * retirée.
 */
export const KYC_REVIEW_PERMISSION = 'kyc.review' satisfies PermissionKey;
export const KYC_REVOCATION_PERMISSION = 'kyc.revoke' satisfies PermissionKey;
