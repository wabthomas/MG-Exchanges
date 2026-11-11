import type { ErrorCode, FieldError } from '@mgx/contracts';

export interface AppErrorOptions {
  /** Erreur d'origine, conservée pour les journaux — jamais renvoyée au client. */
  readonly cause?: unknown;
  /** Détail par champ, renvoyé au client (erreurs de validation). */
  readonly errors?: readonly FieldError[];
  /** Délai avant nouvelle tentative, renvoyé dans l'en-tête `Retry-After` (secondes). */
  readonly retryAfterSeconds?: number;
}

/**
 * Erreur applicative attendue, traduite en réponse HTTP par le filtre global.
 *
 * Contrat : `message` est rédigé pour le client (en anglais, sans donnée interne ni
 * secret) et `code` appartient au catalogue public de `@mgx/contracts`. Toute autre
 * exception est considérée comme inattendue et masquée derrière une erreur 500 générique.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly errors: readonly FieldError[] | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.errors = options.errors;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
