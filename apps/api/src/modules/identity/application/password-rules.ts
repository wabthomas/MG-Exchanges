import { AppError } from '../../../common/errors/app-error.js';
import {
  checkPasswordPolicy,
  PASSWORD_REJECTION_MESSAGES,
  type PasswordOwner,
} from '../domain/password-policy.js';

/** @throws AppError `VALIDATION_FAILED` (champ désigné par `field`) si le mot de passe est refusé. */
export function assertAcceptablePassword(
  password: string,
  owner: PasswordOwner,
  field: string,
): void {
  const rejection = checkPasswordPolicy(password, owner);
  if (rejection !== null) {
    throw new AppError('VALIDATION_FAILED', 'Request validation failed.', {
      errors: [{ path: field, message: PASSWORD_REJECTION_MESSAGES[rejection] }],
    });
  }
}
