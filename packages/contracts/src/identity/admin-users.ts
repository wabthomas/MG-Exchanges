import {
  emailSchema,
  isoDateSchema,
  isoDateTimeSchema,
  localeSchema,
  phoneNumberSchema,
  uuidSchema,
} from '@mgx/validation';
import { z } from 'zod';

import { ACCOUNT_CLOSURE_GROUNDS, adminAccountClosureSchema } from './account-lifecycle.js';
import { ACCOUNT_TYPES, USER_STATUSES } from './auth.js';
import { kycVerifiedLevelSchema } from './kyc-levels.js';
import { permissionKeySchema, ROLE_KEY_PATTERN } from './permissions.js';
import { accountTermsSchema } from './terms.js';

/** Longueur minimale de la justification d'une action du back-office sur un compte. */
export const ADMIN_ACTION_REASON_MIN_LENGTH = 10;

/** Justification d'une action du back-office, conservée dans le journal d'audit. */
export const adminActionReasonSchema = z
  .string()
  .trim()
  .min(ADMIN_ACTION_REASON_MIN_LENGTH)
  .max(500);

export const ADMIN_PAGE_MAX_SIZE = 100;

const pageLimitSchema = z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX_SIZE).default(20);

// --- Comptes ------------------------------------------------------------------------------------

export const adminUserSummarySchema = z.object({
  id: uuidSchema,
  email: z.string(),
  emailVerified: z.boolean(),
  phone: z.string().nullable(),
  phoneVerified: z.boolean(),
  countryCode: z.string(),
  accountType: z.enum(ACCOUNT_TYPES),
  status: z.enum(USER_STATUSES),
  /** Rôles du back-office détenus par le compte (vide pour un client). */
  roles: z.array(z.string()),
  secondFactorEnabled: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

/** Parcours de la liste des comptes, du plus récent au plus ancien, éventuellement par statut. */
export const adminUserListQuerySchema = z.strictObject({
  status: z.enum(USER_STATUSES).optional(),
  limit: pageLimitSchema,
  /** Curseur : `nextCursor` de la page précédente. */
  before: uuidSchema.optional(),
});
export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

export const adminUserListSchema = z.object({
  users: z.array(adminUserSummarySchema),
  nextCursor: uuidSchema.nullable(),
});
export type AdminUserList = z.infer<typeof adminUserListSchema>;

/**
 * Recherche d'un compte par un identifiant **complet** — un seul : adresse e-mail (`email`),
 * numéro de téléphone au format international (`phone`) ou identifiant de compte (`id`). Il
 * n'y a pas de recherche par fragment : on ne consulte que le compte dont on détient un
 * identifiant.
 *
 * L'identifiant voyage dans le **corps** de la requête : une adresse ou un numéro n'ont pas à
 * figurer dans une URL, que serveurs, proxys et navigateurs conservent dans leurs journaux.
 */
export const adminUserLookupRequestSchema = z
  .strictObject({
    email: emailSchema.optional(),
    phone: phoneNumberSchema.optional(),
    id: uuidSchema.optional(),
  })
  .refine(
    (value) => [value.email, value.phone, value.id].filter((id) => id !== undefined).length === 1,
    { error: 'Provide exactly one of "email", "phone" and "id".', path: ['email'] },
  );
export type AdminUserLookupRequest = z.infer<typeof adminUserLookupRequestSchema>;

/** Nombre maximal de comptes retournés par une recherche (un numéro non vérifié peut être déclaré par plusieurs). */
export const ADMIN_LOOKUP_MAX_RESULTS = 20;

export const adminUserLookupResultSchema = z.object({
  /** Comptes correspondant exactement à l'identifiant — le plus souvent un seul, ou aucun. */
  users: z.array(adminUserSummarySchema),
});
export type AdminUserLookupResult = z.infer<typeof adminUserLookupResultSchema>;

export const adminUserDetailSchema = adminUserSummarySchema.extend({
  locale: localeSchema,
  updatedAt: isoDateTimeSchema,
  /**
   * Identité et adresse du titulaire : celles des dossiers de vérification acceptés lorsque
   * `verification` l'indique, sinon simplement **déclarées**.
   */
  profile: z.object({
    givenName: z.string().nullable(),
    familyName: z.string().nullable(),
    additionalName: z.string().nullable(),
    dateOfBirth: isoDateSchema.nullable(),
    placeOfBirth: z.string().nullable(),
    nationality: z.string().nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    postalCode: z.string().nullable(),
    timeZone: z.string().nullable(),
  }),
  secondFactor: z.object({
    enabled: z.boolean(),
    enabledAt: isoDateTimeSchema.nullable(),
    recoveryCodesRemaining: z.number().int().nonnegative(),
  }),
  /** Vérification d'identité (KYC). */
  verification: z.object({
    /** Niveau vérifié : de `0` (aucun) à `3`. */
    level: kycVerifiedLevelSchema,
    identityVerified: z.boolean(),
    addressVerified: z.boolean(),
  }),
  /** Sessions ouvertes en ce moment. */
  activeSessions: z.number().int().nonnegative(),
  /** Conditions d'utilisation : dernière version acceptée, et s'il en reste une à accepter. */
  terms: accountTermsSchema,
  /** Clôture du compte ; `null` tant qu'il n'est pas clôturé. */
  closure: adminAccountClosureSchema.nullable(),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

/** Action du back-office sur un compte : toujours justifiée. */
export const adminUserActionRequestSchema = z.strictObject({ reason: adminActionReasonSchema });
export type AdminUserActionRequest = z.infer<typeof adminUserActionRequestSchema>;

/**
 * Clôture d'un compte par un membre du personnel : **définitive**. `confirm` doit valoir
 * `true` ; la justification est conservée dans le journal d'audit et n'est jamais communiquée
 * au titulaire.
 */
export const closeUserRequestSchema = z.strictObject({
  ground: z.enum(ACCOUNT_CLOSURE_GROUNDS),
  reason: adminActionReasonSchema,
  confirm: z.literal(true, { error: 'Closing an account is permanent: confirm it.' }),
});
export type CloseUserRequest = z.infer<typeof closeUserRequestSchema>;

export const suspendUserRequestSchema = z.strictObject({
  reason: adminActionReasonSchema,
  /**
   * Prévenir le titulaire par e-mail (par défaut). À désactiver lorsque le prévenir serait
   * contraire à une obligation de confidentialité (enquête en cours). Le message ne donne
   * jamais la raison de la suspension.
   */
  notifyUser: z.boolean().default(true),
});
export type SuspendUserRequest = z.infer<typeof suspendUserRequestSchema>;

export const adminSessionsRevokedSchema = z.object({
  /** Nombre de sessions fermées. */
  revokedSessions: z.number().int().nonnegative(),
});
export type AdminSessionsRevoked = z.infer<typeof adminSessionsRevokedSchema>;

// --- Rôles et changements de rôle ---------------------------------------------------------------

export const roleSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  /** Rôle système : défini par la plateforme, non modifiable. */
  isSystem: z.boolean(),
  permissions: z.array(permissionKeySchema),
  /** Nombre de comptes détenant ce rôle. */
  holders: z.number().int().nonnegative(),
});
export type Role = z.infer<typeof roleSchema>;

export const roleListSchema = z.object({ roles: z.array(roleSchema) });
export type RoleList = z.infer<typeof roleListSchema>;

export const ROLE_CHANGE_ACTIONS = ['GRANT', 'REVOKE'] as const;
export type RoleChangeAction = (typeof ROLE_CHANGE_ACTIONS)[number];

/**
 * `PENDING` attend la décision d'un second administrateur ; `APPROVED` a été appliquée ;
 * `REJECTED` a été refusée ; `CANCELLED` a été retirée par son auteur ; `EXPIRED` est restée
 * sans décision jusqu'à son échéance.
 */
export const ROLE_CHANGE_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type RoleChangeStatus = (typeof ROLE_CHANGE_STATUSES)[number];

/** Durée pendant laquelle une demande de changement de rôle peut être approuvée. */
export const ROLE_CHANGE_TTL_HOURS = 72;

export const createRoleChangeRequestSchema = z.strictObject({
  /** Compte dont les rôles changent. */
  userId: uuidSchema,
  roleKey: z.string().max(64).regex(ROLE_KEY_PATTERN),
  action: z.enum(ROLE_CHANGE_ACTIONS),
  reason: adminActionReasonSchema,
});
export type CreateRoleChangeRequest = z.infer<typeof createRoleChangeRequestSchema>;

const accountReferenceSchema = z.object({ id: uuidSchema, email: z.string() });

export const roleChangeSchema = z.object({
  id: uuidSchema,
  user: accountReferenceSchema,
  role: z.object({ key: z.string(), name: z.string() }),
  action: z.enum(ROLE_CHANGE_ACTIONS),
  reason: z.string(),
  status: z.enum(ROLE_CHANGE_STATUSES),
  requestedBy: accountReferenceSchema,
  requestedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  /** Auteur de la décision ; `null` pour une demande en attente ou échue. */
  decidedBy: accountReferenceSchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  decisionNote: z.string().nullable(),
});
export type RoleChange = z.infer<typeof roleChangeSchema>;

export const roleChangeListQuerySchema = z.strictObject({
  status: z.enum(ROLE_CHANGE_STATUSES).optional(),
  limit: pageLimitSchema,
  before: uuidSchema.optional(),
});
export type RoleChangeListQuery = z.infer<typeof roleChangeListQuerySchema>;

export const roleChangeListSchema = z.object({
  /** De la plus récente à la plus ancienne. */
  roleChanges: z.array(roleChangeSchema),
  nextCursor: uuidSchema.nullable(),
});
export type RoleChangeList = z.infer<typeof roleChangeListSchema>;

/** Approbation : une note est facultative, et le corps de la requête aussi. */
export const approveRoleChangeRequestSchema = z
  .strictObject({ note: z.string().trim().min(1).max(500).optional() })
  .default({});
export type ApproveRoleChangeRequest = z.infer<typeof approveRoleChangeRequestSchema>;

/** Refus : il est motivé. */
export const rejectRoleChangeRequestSchema = z.strictObject({ note: adminActionReasonSchema });
export type RejectRoleChangeRequest = z.infer<typeof rejectRoleChangeRequestSchema>;
