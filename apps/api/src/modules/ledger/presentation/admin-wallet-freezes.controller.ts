import {
  type FreezeWalletRequest,
  freezeWalletRequestSchema,
  type LiftWalletFreezeRequest,
  liftWalletFreezeRequestSchema,
  WALLET_FREEZE_STATUSES,
  type WalletFreeze,
  type WalletFreezeList,
  type WalletFreezeListQuery,
  walletFreezeListQuerySchema,
  walletFreezeListSchema,
  walletFreezeSchema,
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
import { staffActorOf } from '../../identity/presentation/admin-users.controller.js';
import { AllowDuringMaintenance } from '../../system-settings/presentation/access.decorators.js';
import { WalletFreezeService } from '../application/wallet-freeze.service.js';

const FREEZE_ID = { name: 'freezeId', schema: { type: 'string', format: 'uuid' } } as const;

/**
 * Back-office : gel des portefeuilles. Reste accessible pendant la maintenance — on doit
 * pouvoir geler un portefeuille à tout moment. Comme toute route d'administration, exige une
 * permission et la validation en deux étapes.
 */
@ApiTags('Administration')
@ApiBearerAuth()
@AllowDuringMaintenance()
@Controller({ path: 'admin/ledger/wallet-freezes', version: '1' })
export class AdminWalletFreezesController {
  constructor(private readonly freezes: WalletFreezeService) {}

  @Get()
  @RequirePermissions('wallet_freezes.read')
  @ApiOperation({
    summary: 'List wallet freezes',
    description:
      'Most recent first, optionally filtered by account holder (`userId`) and by `status` — ' +
      '`ACTIVE`: the wallet is frozen; `LIFTED`: the freeze was lifted, and remains as its ' +
      'record. Page with `after` = the `nextCursor` of the previous page. The consultation is ' +
      'recorded in the audit log. Requires `wallet_freezes.read`.',
  })
  @ApiQuery({ name: 'userId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'status',
    required: false,
    schema: { type: 'string', enum: [...WALLET_FREEZE_STATUSES] },
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'after', required: false, schema: { type: 'string' } })
  @ApiOkResponse({ schema: toOpenApiSchema(walletFreezeListSchema) })
  @ApiProblemResponses(400, 401, 403, 429)
  list(
    @Query({ schema: walletFreezeListQuerySchema }) query: WalletFreezeListQuery,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<WalletFreezeList> {
    return this.freezes.list(query, staffActorOf(user, client));
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('wallet_freezes.create')
  @ApiOperation({
    summary: 'Freeze a wallet',
    description:
      'Freezes the wallet of an account holder in one asset. **Effective at once**: no ' +
      'movement passes on that wallet any more — the holder can neither send from it nor ' +
      'receive into it — except manual adjustments under dual approval, through which funds ' +
      'can still leave it. The balance stays. A movement in progress on the wallet completes ' +
      'first; any later one is refused. The database enforces the freeze itself, whatever ' +
      'the operation.\n\n' +
      'The holder sees the wallet as `frozen` and finds the freeze in the activity history of ' +
      'the account, **never the reason**; no e-mail is sent. An account with a frozen wallet ' +
      'cannot be closed. You cannot freeze your own wallet. Answers `CONFLICT` if the wallet ' +
      'is already frozen, or if the account is closed.\n\n' +
      'The mandatory `reason` is written to the audit log. Requires `wallet_freezes.create`.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(freezeWalletRequestSchema) })
  @ApiCreatedResponse({ schema: toOpenApiSchema(walletFreezeSchema) })
  @ApiProblemResponses(400, 401, 403, 409, 422, 429)
  freeze(
    @Body({ schema: freezeWalletRequestSchema }) body: FreezeWalletRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<WalletFreeze> {
    return this.freezes.freeze(body, staffActorOf(user, client));
  }

  @Post(':freezeId/lift')
  @HttpCode(200)
  @RequirePermissions('wallet_freezes.lift')
  @ApiOperation({
    summary: 'Lift a wallet freeze',
    description:
      'Lifts a freeze in force: the wallet can be used again **at once**. The freeze remains ' +
      'as its record, with who lifted it, when and why. You cannot lift the freeze of your ' +
      'own wallet. Answers `CONFLICT` if the freeze was already lifted.\n\n' +
      'The mandatory `reason` is written to the audit log. Requires `wallet_freezes.lift` — a ' +
      'different permission from the one that freezes.',
  })
  @ApiParam(FREEZE_ID)
  @ApiBody({ schema: toOpenApiInputSchema(liftWalletFreezeRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(walletFreezeSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429)
  lift(
    @Param('freezeId', { schema: uuidSchema }) freezeId: string,
    @Body({ schema: liftWalletFreezeRequestSchema }) body: LiftWalletFreezeRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<WalletFreeze> {
    return this.freezes.lift(freezeId, body, staffActorOf(user, client));
  }
}
