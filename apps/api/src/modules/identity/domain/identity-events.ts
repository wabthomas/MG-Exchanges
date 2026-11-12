/** Un code à usage unique doit être émis et envoyé pour le défi désigné. */
export const VERIFICATION_CODE_REQUESTED_EVENT = 'identity.verification_code_requested';

/** Un message d'information de sécurité doit être envoyé au titulaire du compte. */
export const SECURITY_NOTICE_REQUESTED_EVENT = 'identity.security_notice_requested';

export const SECURITY_NOTICES = [
  'ACCOUNT_ALREADY_EXISTS',
  'REGISTRATION_INCOMPLETE',
  'PASSWORD_CHANGED',
  'NEW_SIGN_IN',
  'TWO_FACTOR_ENABLED',
  'TWO_FACTOR_DISABLED',
  'TWO_FACTOR_RESET_BY_SUPPORT',
  'RECOVERY_CODE_USED',
  'SECOND_FACTOR_BLOCKED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_REACTIVATED',
] as const;

export type SecurityNotice = (typeof SECURITY_NOTICES)[number];
