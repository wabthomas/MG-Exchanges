import {
  type CurrentUser as CurrentUserView,
  currentUserSchema,
  type SessionList,
  sessionListSchema,
} from '@mgx/contracts';
import { uuidSchema } from '@mgx/validation';
import { Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { AllowBeforeTermsAcceptance, CurrentUser } from '../../../common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { ApiProblemResponses, toOpenApiSchema } from '../../../common/http/openapi.js';
import { ReqContext, type RequestContext } from '../../../common/http/request-context.js';
import { AllowDuringMaintenance } from '../../system-settings/presentation/access.decorators.js';
import { AccountService } from '../application/account.service.js';
import { SessionService } from '../application/session.service.js';

/**
 * Le compte et ses sessions. Reste ouvert à un compte qui doit encore accepter les conditions
 * d'utilisation : il doit pouvoir voir où il en est, et fermer une session qu'il ne reconnaît
 * pas.
 */
@ApiTags('Account')
@ApiBearerAuth()
@AllowBeforeTermsAcceptance()
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
  ) {}

  @Get()
  @AllowDuringMaintenance()
  @ApiOperation({
    summary: 'Current account',
    description:
      'The signed-in account, with its back-office roles and permissions if any. ' +
      '`termsAcceptanceRequired` tells whether the account must accept the terms of use in ' +
      'force before continuing (see `GET /me/terms`).',
  })
  @ApiOkResponse({ schema: toOpenApiSchema(currentUserSchema) })
  @ApiProblemResponses(401, 429)
  me(@CurrentUser() user: AuthenticatedUser): Promise<CurrentUserView> {
    return this.accounts.getCurrent(user.userId);
  }

  @Get('sessions')
  @ApiOperation({
    summary: 'List my sessions',
    description:
      'Open sessions of the account (one per signed-in device), most recently used first.',
  })
  @ApiOkResponse({ schema: toOpenApiSchema(sessionListSchema) })
  @ApiProblemResponses(401, 429)
  listSessions(@CurrentUser() user: AuthenticatedUser): Promise<SessionList> {
    return this.sessions.list(user);
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Close all my other sessions',
    description: 'Signs out every device except the one making the request.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['revoked'],
      properties: { revoked: { type: 'integer', description: 'Number of sessions closed.' } },
    },
  })
  @ApiProblemResponses(401, 429)
  async revokeOtherSessions(
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<{ revoked: number }> {
    return { revoked: await this.sessions.revokeOthers(user, client) };
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Close one of my sessions',
    description: 'Signs out a device. Takes effect immediately.',
  })
  @ApiParam({ name: 'sessionId', schema: { type: 'string', format: 'uuid' } })
  @ApiNoContentResponse({ description: 'Session closed.' })
  @ApiProblemResponses(400, 401, 404, 429)
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', { schema: uuidSchema }) sessionId: string,
    @ReqContext() client: RequestContext,
  ): Promise<void> {
    await this.sessions.revoke(user, sessionId, client);
  }
}
