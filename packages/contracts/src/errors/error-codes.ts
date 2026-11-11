/**
 * Catalogue des codes d'erreur de l'API.
 *
 * Le `code` est l'identifiant **stable** d'une erreur : les clients (web, mobile, partenaires)
 * s'appuient sur lui — jamais sur le texte du message — pour décider du comportement et de
 * la traduction affichée. Un code publié n'est jamais renommé ni réaffecté.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: { status: 400, title: 'Bad Request' },
  MALFORMED_REQUEST: { status: 400, title: 'Bad Request' },
  /** Code à usage unique erroné, expiré, déjà utilisé ou trop souvent essayé. */
  INVALID_OR_EXPIRED_CODE: { status: 400, title: 'Bad Request' },
  /** Jeton d'accès absent, invalide ou expiré : renouveler la session ou se reconnecter. */
  UNAUTHENTICATED: { status: 401, title: 'Unauthorized' },
  /** Identifiant ou mot de passe erroné — sans préciser lequel. */
  INVALID_CREDENTIALS: { status: 401, title: 'Unauthorized' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  FEATURE_DISABLED: { status: 403, title: 'Forbidden' },
  /** Mot de passe correct, mais l'adresse e-mail du compte n'a pas encore été vérifiée. */
  EMAIL_NOT_VERIFIED: { status: 403, title: 'Forbidden' },
  /** Mot de passe correct, mais le compte est suspendu ou clôturé. */
  ACCOUNT_DISABLED: { status: 403, title: 'Forbidden' },
  NOT_FOUND: { status: 404, title: 'Not Found' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'Method Not Allowed' },
  NOT_ACCEPTABLE: { status: 406, title: 'Not Acceptable' },
  REQUEST_TIMEOUT: { status: 408, title: 'Request Timeout' },
  CONFLICT: { status: 409, title: 'Conflict' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Content Too Large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported Media Type' },
  UNPROCESSABLE_ENTITY: { status: 422, title: 'Unprocessable Content' },
  /** Le pays de résidence déclaré n'est pas (encore) desservi. */
  COUNTRY_NOT_SUPPORTED: { status: 422, title: 'Unprocessable Content' },
  RATE_LIMITED: { status: 429, title: 'Too Many Requests' },
  INTERNAL_ERROR: { status: 500, title: 'Internal Server Error' },
  MAINTENANCE: { status: 503, title: 'Service Unavailable' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service Unavailable' },
} as const satisfies Record<string, { readonly status: number; readonly title: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_CODE_VALUES = Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);
}
