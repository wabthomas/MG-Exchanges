import {
  type AdminTermsVersion,
  type AdminTermsVersionList,
  adminTermsVersionListSchema,
  adminTermsVersionSchema,
  publishTermsVersionRequestSchema,
  TERMS_BODY_MAX_LENGTH,
  TERMS_PUBLICATION_MAX_BYTES,
} from '@mgx/contracts';
import { Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUser, RequirePermissions } from '../../../common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { readJsonBody } from '../../../common/http/deferred-json-body.js';
import {
  ApiProblemResponses,
  toOpenApiInputSchema,
  toOpenApiSchema,
} from '../../../common/http/openapi.js';
import type { RawBodyLimits } from '../../../common/http/raw-body.js';
import { ReqContext, type RequestContext } from '../../../common/http/request-context.js';
import { RateLimit } from '../../../infrastructure/rate-limit/rate-limit.decorators.js';
import { AllowDuringMaintenance } from '../../system-settings/presentation/access.decorators.js';
import { TermsAdministrationService } from '../application/terms-administration.service.js';
import { staffActorOf } from './admin-users.controller.js';
import { TERMS_PUBLICATION_RATE_LIMIT } from './auth-rate-limits.js';

/**
 * Réception d'une publication. Deux textes de la longueur maximale tiennent dans la limite
 * s'ils sont en français ou en anglais (un à deux octets par caractère) ; la limite en octets
 * s'applique en plus de la limite en caractères. Le corps n'est lu qu'après
 * l'authentification et le contrôle des droits.
 */
export const TERMS_PUBLICATION_LIMITS: RawBodyLimits = {
  maxBytes: TERMS_PUBLICATION_MAX_BYTES,
  discardUpToBytes: 2 * TERMS_PUBLICATION_MAX_BYTES,
  timeoutMs: 30_000,
};

/**
 * Back-office : conditions d'utilisation. Reste accessible pendant la maintenance — on doit
 * pouvoir publier un texte avant de rouvrir la plateforme. Comme toute route d'administration,
 * exige une permission et la validation en deux étapes.
 */
@ApiTags('Administration')
@ApiBearerAuth()
@AllowDuringMaintenance()
@RequirePermissions('terms.publish')
@Controller({ path: 'admin/terms', version: '1' })
export class AdminTermsController {
  constructor(private readonly administration: TermsAdministrationService) {}

  @Get('versions')
  @ApiOperation({
    summary: 'List the versions of the terms of use',
    description:
      'Most recent first (at most 100), without their text: who published each version and ' +
      'when, its rule, the length and SHA-256 digest of each text, and how many open accounts ' +
      'accepted it. `publishedBy` is `null` for a version installed from the command line of ' +
      'the server. The texts themselves are public: `GET /terms/versions/{number}`. Requires ' +
      '`terms.publish`.',
  })
  @ApiOkResponse({ schema: toOpenApiSchema(adminTermsVersionListSchema) })
  @ApiProblemResponses(401, 403, 429)
  list(): Promise<AdminTermsVersionList> {
    return this.administration.list();
  }

  @Post('versions')
  @HttpCode(201)
  @RateLimit(TERMS_PUBLICATION_RATE_LIMIT)
  @ApiOperation({
    summary: 'Publish a new version of the terms of use',
    description:
      '**Permanent.** A published version is never changed nor withdrawn: correcting a text ' +
      'means publishing the next version. It is in force at once.\n\n' +
      '`number` must be the number of the version in force plus one (`1` for the first): a ' +
      'request sent twice, or prepared from an outdated state, is refused (`409`) instead of ' +
      'creating one version too many. `requiresAcceptance` is the rule of this version: ' +
      '`true` — every account must accept it before continuing (see `GET /me/terms`); `false` ' +
      '— it is only shown as the version in force, and accounts that accepted an earlier ' +
      'version are not interrupted. The first version always requires acceptance, and a new ' +
      'registration always accepts the version in force.\n\n' +
      'The French text is mandatory and prevails; `en` is an optional translation. Texts are ' +
      'plain text or Markdown — the API does not interpret them — and are stored exactly as ' +
      `received, at most ${String(TERMS_BODY_MAX_LENGTH)} characters each, in a request of ` +
      `at most ${String(TERMS_PUBLICATION_MAX_BYTES)} bytes of valid UTF-8. The response ` +
      'gives the SHA-256 digest of each stored text: compare it with the digest of the file ' +
      'that was meant to be published. No e-mail is sent to account holders.\n\n' +
      'The mandatory `reason` is written to the audit log. Requires `terms.publish`.',
  })
  @ApiConsumes('application/json')
  @ApiBody({ schema: toOpenApiInputSchema(publishTermsVersionRequestSchema) })
  @ApiCreatedResponse({ schema: toOpenApiSchema(adminTermsVersionSchema) })
  @ApiProblemResponses(400, 401, 403, 408, 409, 413, 415, 429)
  async publish(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminTermsVersion> {
    // Lu ici, et non par l'analyseur global : les gardes ont déjà admis la requête.
    const body = await readJsonBody(
      request,
      response,
      publishTermsVersionRequestSchema,
      TERMS_PUBLICATION_LIMITS,
    );
    return this.administration.publish(body, staffActorOf(user, client));
  }
}
