import {
  type AcceptTermsRequest,
  acceptTermsRequestSchema,
  type TermsDocument,
  termsDocumentSchema,
  type TermsLocaleQuery,
  termsLocaleQuerySchema,
  type TermsStatus,
  termsStatusSchema,
  type TermsVersionList,
  termsVersionListSchema,
  termsVersionNumberParamSchema,
} from '@mgx/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import {
  AllowBeforeTermsAcceptance,
  CurrentUser,
  Public,
} from '../../../common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import {
  ApiProblemResponses,
  toOpenApiInputSchema,
  toOpenApiSchema,
} from '../../../common/http/openapi.js';
import { ReqContext, type RequestContext } from '../../../common/http/request-context.js';
import { RateLimit } from '../../../infrastructure/rate-limit/rate-limit.decorators.js';
import { AllowDuringMaintenance } from '../../system-settings/presentation/access.decorators.js';
import { TermsService } from '../application/terms.service.js';
import { TERMS_READING_RATE_LIMIT } from './auth-rate-limits.js';

const LOCALE_QUERY = {
  name: 'locale',
  required: false,
  schema: { type: 'string', enum: ['fr', 'en'], default: 'fr' },
  description:
    'Language wanted. A version that was not published in this language is served in French ' +
    '— the French text prevails; `locale` in the response tells which one was served.',
} as const;

/**
 * Conditions d'utilisation : lecture publique. Les textes publiés ne sont pas des secrets —
 * on doit pouvoir les lire avant de s'inscrire, et relire une version passée.
 */
@ApiTags('Terms of use')
@Public()
@AllowDuringMaintenance()
@RateLimit(TERMS_READING_RATE_LIMIT)
@Controller({ path: 'terms', version: '1' })
export class TermsController {
  constructor(private readonly terms: TermsService) {}

  @Get('current')
  @ApiOperation({
    summary: 'Read the terms of use in force',
    description:
      'The latest published version, with its text exactly as it was published and the ' +
      'SHA-256 digest of that text. Its `number` is what registration ' +
      '(`acceptedTermsVersion`) and `POST /me/terms/acceptance` (`version`) expect. Answers ' +
      '`404` until a first version is published.',
  })
  @ApiQuery(LOCALE_QUERY)
  @ApiOkResponse({ schema: toOpenApiSchema(termsDocumentSchema) })
  @ApiProblemResponses(400, 404, 429)
  current(
    @Query({ schema: termsLocaleQuerySchema }) query: TermsLocaleQuery,
  ): Promise<TermsDocument> {
    return this.terms.current(query.locale);
  }

  @Get('versions')
  @ApiOperation({
    summary: 'List the published versions of the terms of use',
    description:
      'Most recent first, without their text: number, publication date, whether the version ' +
      'had to be accepted, and the summary of what it changed. At most the 100 most recent ' +
      'versions.',
  })
  @ApiQuery(LOCALE_QUERY)
  @ApiOkResponse({ schema: toOpenApiSchema(termsVersionListSchema) })
  @ApiProblemResponses(400, 429)
  list(
    @Query({ schema: termsLocaleQuerySchema }) query: TermsLocaleQuery,
  ): Promise<TermsVersionList> {
    return this.terms.list(query.locale);
  }

  @Get('versions/:number')
  @ApiOperation({
    summary: 'Read one version of the terms of use',
    description:
      'A version, in force or superseded, with its text. A published version never changes: ' +
      'what an account accepted remains readable here.',
  })
  @ApiParam({ name: 'number', schema: { type: 'integer', minimum: 1 } })
  @ApiQuery(LOCALE_QUERY)
  @ApiOkResponse({ schema: toOpenApiSchema(termsDocumentSchema) })
  @ApiProblemResponses(400, 404, 429)
  version(
    @Param('number', { schema: termsVersionNumberParamSchema }) number: number,
    @Query({ schema: termsLocaleQuerySchema }) query: TermsLocaleQuery,
  ): Promise<TermsDocument> {
    return this.terms.version(number, query.locale);
  }
}

/**
 * Conditions d'utilisation : où en est mon compte, et acceptation. Ces deux routes restent
 * ouvertes à un compte qui doit encore accepter — c'est par elles qu'il s'en acquitte.
 */
@ApiTags('Terms of use')
@ApiBearerAuth()
@AllowBeforeTermsAcceptance()
@Controller({ path: 'me/terms', version: '1' })
export class MyTermsController {
  constructor(private readonly terms: TermsService) {}

  @Get()
  @ApiOperation({
    summary: 'Where my account stands with the terms of use',
    description:
      'The version in force, the latest version the account accepted, and whether it must ' +
      'accept the version in force before continuing (`acceptanceRequired`). While it must, ' +
      'most routes of the account answer `403 TERMS_ACCEPTANCE_REQUIRED`: only signing out, ' +
      'reading `GET /me`, the security settings (password, sessions, two-step verification), ' +
      'the activity history, the copy of the data, closing the account and these two routes ' +
      'remain available.',
  })
  @ApiOkResponse({ schema: toOpenApiSchema(termsStatusSchema) })
  @ApiProblemResponses(401, 429)
  status(@CurrentUser() user: AuthenticatedUser): Promise<TermsStatus> {
    return this.terms.status(user.userId);
  }

  @Post('acceptance')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept the terms of use in force',
    description:
      '`version` is the number of the text the holder was shown (`GET /terms/current`). It ' +
      'must be the version in force: otherwise `409 TERMS_VERSION_NOT_CURRENT` — read the ' +
      'current version, show it, and try again. Accepting the same version twice changes ' +
      'nothing: the first acceptance and its date stand. The acceptance is recorded in the ' +
      'activity history with the digest of the accepted text.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(acceptTermsRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(termsStatusSchema) })
  @ApiProblemResponses(400, 401, 409, 429)
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: acceptTermsRequestSchema }) body: AcceptTermsRequest,
    @ReqContext() client: RequestContext,
  ): Promise<TermsStatus> {
    return this.terms.accept(user, body, client);
  }
}
