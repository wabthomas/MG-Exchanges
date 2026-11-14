import {
  type AdminTransferLimit,
  type AdminTransferLimitList,
  adminTransferLimitListSchema,
  adminTransferLimitSchema,
  type KycVerifiedLevel,
  type SetTransferLimitRequest,
  setTransferLimitRequestSchema,
  transferLimitLevelParamSchema,
} from '@mgx/contracts';
import { assetCodeSchema } from '@mgx/validation';
import { Body, Controller, Get, HttpCode, Param, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
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
import type { StaffActor } from '../../identity/application/admin-users.service.js';
import { AllowDuringMaintenance } from '../../system-settings/presentation/access.decorators.js';
import { TransferLimitsService } from '../application/transfer-limits.service.js';

function staffOf(user: AuthenticatedUser, client: RequestContext): StaffActor {
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
 * Back-office : plafonds de transfert par niveau de vérification et par actif. Reste
 * accessible pendant la maintenance — c'est le moment de les régler. Comme toute route
 * d'administration, exige une permission et la validation en deux étapes.
 */
@ApiTags('Administration')
@ApiBearerAuth()
@AllowDuringMaintenance()
@Controller({ path: 'admin/transfer-limits', version: '1' })
export class AdminTransferLimitsController {
  constructor(private readonly limits: TransferLimitsService) {}

  @Get()
  @RequirePermissions('transfer_limits.read')
  @ApiOperation({
    summary: 'List the transfer limits',
    description:
      'Every limit that was set, in the order of asset codes then of verification levels ' +
      '(`0`: no level verified). **An asset and level that are not listed have no limit: ' +
      'accounts of that level can neither send nor receive that asset** — nor can they when ' +
      'the limit per transfer is zero. Amounts are **decimal strings** with exactly ' +
      '`asset.scale` decimals. The consultation is recorded in the audit log. Requires ' +
      '`transfer_limits.read`.',
  })
  @ApiOkResponse({ schema: toOpenApiSchema(adminTransferLimitListSchema) })
  @ApiProblemResponses(401, 403, 429)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminTransferLimitList> {
    return this.limits.list(staffOf(user, client));
  }

  @Put(':assetCode/:level')
  @HttpCode(200)
  @RequirePermissions('transfer_limits.write')
  @ApiOperation({
    summary: 'Set the transfer limits of a verification level in an asset',
    description:
      'Sets — or replaces — what accounts of verification level `level` (`0` to `3`) may ' +
      'send in `assetCode`: `perTransfer`, per transfer; `daily`, over any 24 hours; ' +
      '`monthly`, over any 31 days. **Effective at once**: the next transfer is examined with ' +
      'them. The three amounts are **decimal strings** with at most `asset.scale` decimals, ' +
      'and must be in order: `perTransfer` ≤ `daily` ≤ `monthly`.\n\n' +
      'Setting limits for a level **opens** the asset to it, for sending and for receiving. ' +
      'Limits are never removed: set the three amounts to `0` to close the asset to that ' +
      'level again. Transfers also require the `internalTransfers` feature to be open. ' +
      'Answers `NOT_FOUND` for an asset the platform does not keep.\n\n' +
      'The mandatory `reason` is written to the audit log with the limits before and after. ' +
      'Requires `transfer_limits.write`.',
  })
  @ApiParam({ name: 'assetCode', schema: { type: 'string', example: 'USD' } })
  @ApiParam({ name: 'level', schema: { type: 'integer', minimum: 0, maximum: 3 } })
  @ApiBody({ schema: toOpenApiInputSchema(setTransferLimitRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(adminTransferLimitSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 429)
  set(
    @Param('assetCode', { schema: assetCodeSchema }) assetCode: string,
    @Param('level', { schema: transferLimitLevelParamSchema }) level: KycVerifiedLevel,
    @Body({ schema: setTransferLimitRequestSchema }) body: SetTransferLimitRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminTransferLimit> {
    return this.limits.set(assetCode, level, body, staffOf(user, client));
  }
}
