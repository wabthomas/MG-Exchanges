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

const PROBLEM_SCHEMA = toOpenApiSchema(problemDetailsSchema);

/** Documente les réponses d'erreur (`application/problem+json`) d'une route. */
export function ApiProblemResponses(
  ...statuses: readonly number[]
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: 'Error (RFC 9457 problem details).',
        content: { 'application/problem+json': { schema: PROBLEM_SCHEMA } },
      }),
    ),
  );
}
