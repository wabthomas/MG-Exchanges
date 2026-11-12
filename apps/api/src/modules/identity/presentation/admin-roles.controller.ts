import {
  type ApproveRoleChangeRequest,
  approveRoleChangeRequestSchema,
  type CreateRoleChangeRequest,
  createRoleChangeRequestSchema,
  type RejectRoleChangeRequest,
  rejectRoleChangeRequestSchema,
  ROLE_CHANGE_STATUSES,
  ROLE_CHANGE_TTL_HOURS,
  type RoleChange,
  type RoleChangeList,
  type RoleChangeListQuery,
  roleChangeListQuerySchema,
  roleChangeListSchema,
  roleChangeSchema,
  type RoleList,
  roleListSchema,
} from '@mgx/contracts';
import { uuidSchema } from '@mgx/validation';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
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
import { RoleChangeService } from '../application/role-change.service.js';
import { staffActorOf } from './admin-users.controller.js';

const REQUEST_ID = { name: 'requestId', schema: { type: 'string', format: 'uuid' } } as const;

/**
 * Back-office : rôles et changements de rôle sous double validation. Aucune route n'attribue
 * ni ne retire un rôle directement.
 */
@ApiTags('Administration')
@ApiBearerAuth()
@AllowDuringMaintenance()
@Controller({ path: 'admin', version: '1' })
export class AdminRolesController {
  constructor(private readonly roleChanges: RoleChangeService) {}

  @Get('roles')
  @RequirePermissions('roles.read')
  @ApiOperation({
    summary: 'List roles',
    description:
      'Back-office roles with their permissions and number of holders. Roles are defined by ' +
      'the platform. Requires `roles.read`.',
  })
  @ApiOkResponse({ schema: toOpenApiSchema(roleListSchema) })
  @ApiProblemResponses(401, 403, 429)
  listRoles(): Promise<RoleList> {
    return this.roleChanges.listRoles();
  }

  @Get('role-changes')
  @RequirePermissions('roles.read')
  @ApiOperation({
    summary: 'List role change requests',
    description:
      'Most recent first, optionally filtered by `status`. Page with `before` = the ' +
      '`nextCursor` of the previous page. Requires `roles.read`.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    schema: { type: 'string', enum: [...ROLE_CHANGE_STATUSES] },
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'before', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: toOpenApiSchema(roleChangeListSchema) })
  @ApiProblemResponses(400, 401, 403, 429)
  list(
    @Query({ schema: roleChangeListQuerySchema }) query: RoleChangeListQuery,
  ): Promise<RoleChangeList> {
    return this.roleChanges.list(query);
  }

  @Post('role-changes')
  @RequirePermissions('roles.manage')
  @ApiOperation({
    summary: 'Request a role change',
    description:
      'Asks for a role to be granted to, or revoked from, an account. **Nothing changes until ' +
      'a second administrator approves the request**; it lapses after ' +
      `${String(ROLE_CHANGE_TTL_HOURS)} hours. You cannot request a change of your own roles, ` +
      'and one request at most can be pending for an account and a role. Requires `roles.manage`.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(createRoleChangeRequestSchema) })
  @ApiCreatedResponse({ schema: toOpenApiSchema(roleChangeSchema) })
  @ApiProblemResponses(400, 401, 403, 409, 422, 429)
  request(
    @Body({ schema: createRoleChangeRequestSchema }) body: CreateRoleChangeRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<RoleChange> {
    return this.roleChanges.request(body, staffActorOf(user, client));
  }

  @Get('role-changes/:requestId')
  @RequirePermissions('roles.read')
  @ApiOperation({
    summary: 'View a role change request',
    description: 'Requires `roles.read`.',
  })
  @ApiParam(REQUEST_ID)
  @ApiOkResponse({ schema: toOpenApiSchema(roleChangeSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 429)
  get(@Param('requestId', { schema: uuidSchema }) requestId: string): Promise<RoleChange> {
    return this.roleChanges.get(requestId);
  }

  @Post('role-changes/:requestId/approve')
  @HttpCode(200)
  @RequirePermissions('roles.manage')
  @ApiOperation({
    summary: 'Approve a role change request',
    description:
      'Applies the role change. The approver must be a **different administrator** from the ' +
      'author of the request, and cannot be the account concerned. The database enforces the ' +
      'same rules when it applies the change, and also checks that both administrators are ' +
      'still active and still hold `roles.manage`. A role granted to an account takes effect ' +
      'at once; that account must have two-step verification enabled to use the back office. ' +
      'Requires `roles.manage`.',
  })
  @ApiParam(REQUEST_ID)
  @ApiBody({ required: false, schema: toOpenApiInputSchema(approveRoleChangeRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(roleChangeSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429)
  approve(
    @Param('requestId', { schema: uuidSchema }) requestId: string,
    @Body({ schema: approveRoleChangeRequestSchema }) body: ApproveRoleChangeRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<RoleChange> {
    return this.roleChanges.approve(requestId, body, staffActorOf(user, client));
  }

  @Post('role-changes/:requestId/reject')
  @HttpCode(200)
  @RequirePermissions('roles.manage')
  @ApiOperation({
    summary: 'Reject a role change request',
    description:
      'Closes the request without changing any role; the `note` says why. Like an approval, ' +
      'a rejection comes from a second administrator — the author of a request cancels it ' +
      'instead. Requires `roles.manage`.',
  })
  @ApiParam(REQUEST_ID)
  @ApiBody({ schema: toOpenApiInputSchema(rejectRoleChangeRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(roleChangeSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429)
  reject(
    @Param('requestId', { schema: uuidSchema }) requestId: string,
    @Body({ schema: rejectRoleChangeRequestSchema }) body: RejectRoleChangeRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<RoleChange> {
    return this.roleChanges.reject(requestId, body, staffActorOf(user, client));
  }

  @Post('role-changes/:requestId/cancel')
  @HttpCode(200)
  @RequirePermissions('roles.manage')
  @ApiOperation({
    summary: 'Cancel my role change request',
    description: 'Only the author of a pending request can cancel it. Requires `roles.manage`.',
  })
  @ApiParam(REQUEST_ID)
  @ApiOkResponse({ schema: toOpenApiSchema(roleChangeSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429)
  cancel(
    @Param('requestId', { schema: uuidSchema }) requestId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<RoleChange> {
    return this.roleChanges.cancel(requestId, staffActorOf(user, client));
  }
}
