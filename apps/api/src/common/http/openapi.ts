import { problemDetailsSchema } from '@mgx/contracts';
import { applyDecorators } from '@nestjs/common';
import { ApiResponse, type ApiResponseSchemaHost } from '@nestjs/swagger';
import { z } from 'zod';

type OpenApiSchema = ApiResponseSchemaHost['schema'];

/** Convertit un schéma Zod (contrat) en schéma OpenAPI 3.0 pour la documentation. */
export function toOpenApiSchema(schema: z.ZodType): OpenApiSchema {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'output',
  });
  return jsonSchema as OpenApiSchema;
}

/** Convertit le schéma Zod d'un corps de requête (forme attendue en entrée) en schéma OpenAPI 3.0. */
export function toOpenApiInputSchema(schema: z.ZodType): NonNullable<OpenApiSchema> {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
  });
  return jsonSchema as NonNullable<OpenApiSchema>;
}

/** Nom, dans le document OpenAPI, du schéma partagé par toutes les réponses d'erreur. */
export const PROBLEM_SCHEMA_NAME = 'ProblemDetails';

/** Schéma des réponses d'erreur, publié une seule fois dans `components.schemas`. */
export const PROBLEM_OPENAPI_SCHEMA = toOpenApiSchema(problemDetailsSchema);

const STATUS_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Invalid request (`VALIDATION_FAILED`, `MALFORMED_REQUEST`, `INVALID_OR_EXPIRED_CODE`).',
  401: 'Missing or invalid credentials (`UNAUTHENTICATED`, `INVALID_CREDENTIALS`).',
  403: 'Not allowed (`FORBIDDEN`, `FEATURE_DISABLED`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_DISABLED`).',
  404: 'Not found (`NOT_FOUND`).',
  422: 'Understood but refused by a business rule (`UNPROCESSABLE_ENTITY`, `COUNTRY_NOT_SUPPORTED`).',
  429: 'Too many requests or attempts (`RATE_LIMITED`); see the `Retry-After` header.',
  500: 'Unexpected error (`INTERNAL_ERROR`).',
  503: 'Temporarily unavailable (`MAINTENANCE`, `SERVICE_UNAVAILABLE`).',
};

/** Documente les réponses d'erreur (`application/problem+json`) d'une route. */
export function ApiProblemResponses(
  ...statuses: readonly number[]
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: STATUS_DESCRIPTIONS[status] ?? 'Error (RFC 9457 problem details).',
        content: {
          'application/problem+json': {
            schema: { $ref: `#/components/schemas/${PROBLEM_SCHEMA_NAME}` },
          },
        },
      }),
    ),
  );
}
