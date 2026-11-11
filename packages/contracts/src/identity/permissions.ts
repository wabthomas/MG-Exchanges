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
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as [PermissionKey, ...PermissionKey[]];

export const permissionKeySchema = z.enum(PERMISSION_KEYS);

/** Format d'une clé de permission : `ressource.action`. */
export const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * Rôles système, créés par les migrations et non modifiables.
 * `super_admin` détient toutes les permissions du catalogue.
 */
export const SYSTEM_ROLE_KEYS = ['super_admin'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];
