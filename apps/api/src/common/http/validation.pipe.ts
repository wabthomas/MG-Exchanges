import type { FieldError } from '@mgx/contracts';
import { StandardSchemaValidationPipe } from '@nestjs/common';

import { AppError } from '../errors/app-error.js';

type Issue = Parameters<
  NonNullable<ConstructorParameters<typeof StandardSchemaValidationPipe>[0]>['exceptionFactory'] &
    object
>[0][number];

function issuePath(issue: Issue): string {
  return (issue.path ?? [])
    .map((segment) => (typeof segment === 'object' ? segment.key : segment))
    .map(String)
    .join('.');
}

/**
 * Validation systématique des entrées : chaque paramètre de route, de requête ou de corps
 * déclare un schéma (`@Body({ schema })`), partagé avec les clients via `@mgx/contracts`.
 * Une entrée invalide produit une erreur `VALIDATION_FAILED` détaillée champ par champ.
 */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) => {
      const errors: FieldError[] = issues.map((issue) => ({
        path: issuePath(issue),
        message: issue.message,
      }));
      return new AppError('VALIDATION_FAILED', 'Request validation failed.', { errors });
    },
  });
}
