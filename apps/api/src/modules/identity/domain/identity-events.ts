/** Un code à usage unique doit être émis et envoyé pour le défi désigné. */
export const VERIFICATION_CODE_REQUESTED_EVENT = 'identity.verification_code_requested';

/** Un message d'information de sécurité doit être envoyé au titulaire du compte. */
export const SECURITY_NOTICE_REQUESTED_EVENT = 'identity.security_notice_requested';

export type SecurityNotice = 'ACCOUNT_ALREADY_EXISTS' | 'PASSWORD_CHANGED';
