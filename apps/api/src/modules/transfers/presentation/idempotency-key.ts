import { clientIdempotencyKeySchema, IDEMPOTENCY_KEY_HEADER } from '@mgx/contracts';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { AppError } from '../../../common/errors/app-error.js';

/**
 * Lit la clé d'idempotence d'une requête.
 *
 * @throws AppError `VALIDATION_FAILED` si l'en-tête est absent, répété ou mal formé.
 */
export function idempotencyKeyOf(request: Request): string {
  // Un en-tête répété est joint par des virgules : il n'a alors plus le format attendu.
  const parsed = clientIdempotencyKeySchema.safeParse(request.get(IDEMPOTENCY_KEY_HEADER));
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Request validation failed.', {
      errors: [
        {
          path: IDEMPOTENCY_KEY_HEADER,
          message:
            'This header is required: 16 to 128 letters, digits, ".", "_", ":" or "-". ' +
            'Send the same value when retrying the same request.',
        },
      ],
    });
  }
  return parsed.data;
}

/**
 * Injecte la clé d'idempotence fournie par le client (en-tête `Idempotency-Key`), exigée sur
 * toute route qui déplace des fonds.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    idempotencyKeyOf(context.switchToHttp().getRequest<Request>()),
);
