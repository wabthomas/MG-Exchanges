import {
  type AdminAccountClosure,
  adminAccountClosureSchema,
  type CloseUserRequest,
  closeUserRequestSchema,
  type AdminSessionsRevoked,
  adminSessionsRevokedSchema,
  type AdminUserActionRequest,
  adminUserActionRequestSchema,
  type AdminUserDetail,
  adminUserDetailSchema,
  type AdminUserList,
  type AdminUserListQuery,
  adminUserListQuerySchema,
  adminUserListSchema,
  type AdminUserLookupRequest,
  adminUserLookupRequestSchema,
  type AdminUserLookupResult,
  adminUserLookupResultSchema,
  type AdminUserSummary,
  adminUserSummarySchema,
  type SuspendUserRequest,
  suspendUserRequestSchema,
  USER_STATUSES,
} from '@mgx/contracts';
import { uuidSchema } from '@mgx/validation';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser, RequirePermissions } from '../../../common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import {
  ApiProblemResponses,
  toOpenApiInputSchema,
  toOpenApiSchema,
} from '../../../common/http/openapi.js';
import { ReqContext, type RequestContext } from '../../../common/http/request-context.js';
import { AllowDuringMaintenance } from '../../system-settings/presentation/access.decorators.js';
import { AccountClosureService } from '../application/account-closure.service.js';
import { AdminUsersService, type StaffActor } from '../application/admin-users.service.js';

const STAFF_RULES =
  '\n\nThe mandatory `reason` is written to the audit log with the action. You cannot act on ' +
  'your own account, and acting on a staff account (one that holds a role) also requires ' +
  '`roles.manage`.';

export function staffActorOf(user: AuthenticatedUser, client: RequestContext): StaffActor {
  return {
    userId: user.userId,
    client: {
      requestId: client.requestId,
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
    },
  };
}

/**
 * Back-office : comptes des utilisateurs. Reste accessible pendant la maintenance — on doit
 * pouvoir suspendre un compte compromis à tout moment. Comme toute route d'administration,
 * exige une permission et la validation en deux étapes.
 */
@ApiTags('Administration')
@ApiBearerAuth()
@AllowDuringMaintenance()
@Controller({ path: 'admin/users', version: '1' })
export class AdminUsersController {
  constructor(
    private readonly adminUsers: AdminUsersService,
    private readonly closures: AccountClosureService,
  ) {}

  @Get()
  @RequirePermissions('users.read')
  @ApiOperation({
    summary: 'Browse accounts',
    description:
      'Accounts from the most recent to the oldest, optionally filtered by `status`. Page with ' +
      '`before` = the `nextCursor` of the previous page. To find one account, use ' +
      '`POST /admin/users/search`. Every page viewed is recorded in the audit log. Requires ' +
      '`users.read`.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    schema: { type: 'string', enum: [...USER_STATUSES] },
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'before', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: toOpenApiSchema(adminUserListSchema) })
  @ApiProblemResponses(400, 401, 403, 429)
  list(
    @Query({ schema: adminUserListQuerySchema }) query: AdminUserListQuery,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminUserList> {
    return this.adminUsers.list(query, staffActorOf(user, client));
  }

  @Post('search')
  @HttpCode(200)
  @RequirePermissions('users.read')
  @ApiOperation({
    summary: 'Find an account',
    description:
      'Looks accounts up by **one complete identifier**: `email`, `phone` (international ' +
      'format) or `id`. There is no search by fragment. The identifier travels in the request ' +
      'body, never in the URL — servers and proxies keep URLs in their logs. Usually returns ' +
      'one account or none; a phone number that was declared but never verified can belong to ' +
      'several. Every search is recorded in the audit log, with a digest of the identifier ' +
      'only. Requires `users.read`.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(adminUserLookupRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(adminUserLookupResultSchema) })
  @ApiProblemResponses(400, 401, 403, 429)
  lookup(
    @Body({ schema: adminUserLookupRequestSchema }) body: AdminUserLookupRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminUserLookupResult> {
    return this.adminUsers.lookup(body, staffActorOf(user, client));
  }

  @Get(':userId')
  @RequirePermissions('users.read')
  @ApiOperation({
    summary: 'View an account',
    description:
      'Account, declared profile, two-step verification state and number of open sessions. ' +
      'No authentication secret is ever returned. Viewing an account is recorded in the audit ' +
      'log. Requires `users.read`.',
  })
  @ApiParam({ name: 'userId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: toOpenApiSchema(adminUserDetailSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 429)
  get(
    @Param('userId', { schema: uuidSchema }) userId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminUserDetail> {
    return this.adminUsers.get(userId, staffActorOf(user, client));
  }

  @Post(':userId/suspend')
  @HttpCode(200)
  @RequirePermissions('users.suspend')
  @ApiOperation({
    summary: 'Suspend an account',
    description:
      'Only an active account can be suspended. Its sessions are closed at once and it can no ' +
      'longer sign in (`ACCOUNT_DISABLED`). The holder is told by e-mail — never why — unless ' +
      '`notifyUser` is `false`. Requires `users.suspend`.' +
      STAFF_RULES,
  })
  @ApiParam({ name: 'userId', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: toOpenApiInputSchema(suspendUserRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(adminUserSummarySchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429)
  suspend(
    @Param('userId', { schema: uuidSchema }) userId: string,
    @Body({ schema: suspendUserRequestSchema }) body: SuspendUserRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminUserSummary> {
    return this.adminUsers.suspend(userId, body, staffActorOf(user, client));
  }

  @Post(':userId/reactivate')
  @HttpCode(200)
  @RequirePermissions('users.suspend')
  @ApiOperation({
    summary: 'Reactivate a suspended account',
    description:
      'Lifts a suspension: the holder can sign in again and is told by e-mail. Requires ' +
      '`users.suspend`.' +
      STAFF_RULES,
  })
  @ApiParam({ name: 'userId', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: toOpenApiInputSchema(adminUserActionRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(adminUserSummarySchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429)
  reactivate(
    @Param('userId', { schema: uuidSchema }) userId: string,
    @Body({ schema: adminUserActionRequestSchema }) body: AdminUserActionRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminUserSummary> {
    return this.adminUsers.reactivate(userId, body, staffActorOf(user, client));
  }

  @Post(':userId/sessions/revoke')
  @HttpCode(200)
  @RequirePermissions('users.revoke_sessions')
  @ApiOperation({
    summary: 'Sign an account out everywhere',
    description:
      'Closes every session of the account (lost device, suspected compromise). The account ' +
      'stays active: its holder can sign in again. Requires `users.revoke_sessions`.' +
      STAFF_RULES,
  })
  @ApiParam({ name: 'userId', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: toOpenApiInputSchema(adminUserActionRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(adminSessionsRevokedSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 429)
  revokeSessions(
    @Param('userId', { schema: uuidSchema }) userId: string,
    @Body({ schema: adminUserActionRequestSchema }) body: AdminUserActionRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminSessionsRevoked> {
    return this.adminUsers.revokeSessions(userId, body, staffActorOf(user, client));
  }

  @Post(':userId/mfa/reset')
  @HttpCode(204)
  @RequirePermissions('users.reset_mfa')
  @ApiOperation({
    summary: 'Remove the two-step verification of an account',
    description:
      'For a holder who lost both the authenticator app and the recovery codes. The account ' +
      'falls back to its password alone, so this is the most sensitive support action: the ' +
      "holder's identity must have been established first, every session is closed and the " +
      'holder is always told by e-mail. Answers `CONFLICT` when two-step verification is not ' +
      'enabled. Requires `users.reset_mfa`.' +
      STAFF_RULES,
  })
  @ApiParam({ name: 'userId', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: toOpenApiInputSchema(adminUserActionRequestSchema) })
  @ApiNoContentResponse({ description: 'Two-step verification removed.' })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429)
  async resetSecondFactor(
    @Param('userId', { schema: uuidSchema }) userId: string,
    @Body({ schema: adminUserActionRequestSchema }) body: AdminUserActionRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<void> {
    await this.adminUsers.resetSecondFactor(userId, body, staffActorOf(user, client));
  }

  @Post(':userId/close')
  @HttpCode(200)
  @RequirePermissions('users.close')
  @ApiOperation({
    summary: 'Close an account',
    description:
      '**Permanent.** Closes an active or suspended account, at the request of its holder ' +
      'received through another channel (`HOLDER_REQUEST`) or by decision of the platform ' +
      '(`PLATFORM_DECISION`); `confirm` must be `true`. The account is closed exactly as if its ' +
      'holder had done it (see `POST /me/close`), and the holder is told by e-mail — never ' +
      'why. Refused (`409`) while the account holds a back-office role, or while one of its ' +
      'identity verification cases awaits review: decide the case first, so that the decision ' +
      'is kept. The mandatory `reason` is written to the audit log. You cannot close your own ' +
      'account from the back office. Requires `users.close`.',
  })
  @ApiParam({ name: 'userId', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: toOpenApiInputSchema(closeUserRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(adminAccountClosureSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429)
  close(
    @Param('userId', { schema: uuidSchema }) userId: string,
    @Body({ schema: closeUserRequestSchema }) body: CloseUserRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminAccountClosure> {
    return this.closures.closeByStaff(userId, body, staffActorOf(user, client));
  }
}
