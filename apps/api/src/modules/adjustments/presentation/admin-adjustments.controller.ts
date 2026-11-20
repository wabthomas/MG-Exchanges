import {
  type ApproveLedgerAdjustmentRequest,
  approveLedgerAdjustmentRequestSchema,
  type CreateLedgerAdjustmentRequest,
  createLedgerAdjustmentRequestSchema,
  LEDGER_ADJUSTMENT_STATUSES,
  LEDGER_ADJUSTMENT_TTL_HOURS,
  type LedgerAdjustment,
  type LedgerAdjustmentList,
  type LedgerAdjustmentListQuery,
  ledgerAdjustmentListQuerySchema,
  ledgerAdjustmentListSchema,
  ledgerAdjustmentSchema,
  type RejectLedgerAdjustmentRequest,
  rejectLedgerAdjustmentRequestSchema,
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
import {
  AllowDuringMaintenance,
  RequiresFeature,
} from '../../system-settings/presentation/access.decorators.js';
import { AdjustmentService } from '../application/adjustment.service.js';

const ADJUSTMENT_ID = {
  name: 'adjustmentId',
  schema: { type: 'string', format: 'uuid' },
} as const;

const AUDITED = ' The consultation is recorded in the audit log.';

/**
 * Back-office : ajustements manuels des portefeuilles, sous double validation. Aucune route ne
 * crédite ni ne débite un portefeuille directement : une demande, puis l'approbation d'une
 * seconde personne. Reste accessible pendant la maintenance. Comme toute route
 * d'administration, exige une permission et la validation en deux étapes ; demander et
 * approuver exigent en outre que la fonctionnalité `manualAdjustments` soit ouverte.
 */
@ApiTags('Administration')
@ApiBearerAuth()
@AllowDuringMaintenance()
@Controller({ path: 'admin/ledger/adjustments', version: '1' })
export class AdminAdjustmentsController {
  constructor(private readonly adjustments: AdjustmentService) {}

  @Get()
  @RequirePermissions('adjustments.read')
  @ApiOperation({
    summary: 'List manual adjustments',
    description:
      'Most recent first, optionally filtered by `status` and by account holder (`userId`). ' +
      'Page with `after` = the `nextCursor` of the previous page. Amounts are **decimal ' +
      'strings** with exactly `asset.scale` decimals. Requires `adjustments.read`.' +
      AUDITED,
  })
  @ApiQuery({
    name: 'status',
    required: false,
    schema: { type: 'string', enum: [...LEDGER_ADJUSTMENT_STATUSES] },
  })
  @ApiQuery({ name: 'userId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'after', required: false, schema: { type: 'string' } })
  @ApiOkResponse({ schema: toOpenApiSchema(ledgerAdjustmentListSchema) })
  @ApiProblemResponses(400, 401, 403, 429)
  list(
    @Query({ schema: ledgerAdjustmentListQuerySchema }) query: LedgerAdjustmentListQuery,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<LedgerAdjustmentList> {
    return this.adjustments.list(query, staffActorOf(user, client));
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('adjustments.request')
  @RequiresFeature('manualAdjustments')
  @ApiOperation({
    summary: 'Request a manual adjustment of a wallet',
    description:
      'Asks for the wallet of an account holder to be credited (`CREDIT`) or debited ' +
      '(`DEBIT`) of `amount` in `assetCode` — a **decimal string** with at most `asset.scale` ' +
      'decimals. **Nothing moves until a second member of staff approves the request**; it ' +
      `lapses after ${String(LEDGER_ADJUSTMENT_TTL_HOURS)} hours. The counterpart of the ` +
      'entry is the custody account of the platform.\n\n' +
      'You cannot request an adjustment of your own wallet. One identical request at most — ' +
      'same wallet, same direction, same amount — can be pending: a second one answers ' +
      '`CONFLICT`. A debit larger than the balance of the wallet answers ' +
      '`INSUFFICIENT_FUNDS`. The account must be active or suspended; a frozen wallet can be ' +
      'adjusted.\n\n' +
      'The mandatory `reason` stays internal — the account holder never sees it — and is ' +
      'written to the audit log. Requires `adjustments.request` and the `manualAdjustments` ' +
      'feature to be open.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(createLedgerAdjustmentRequestSchema) })
  @ApiCreatedResponse({ schema: toOpenApiSchema(ledgerAdjustmentSchema) })
  @ApiProblemResponses(400, 401, 403, 409, 422, 429)
  request(
    @Body({ schema: createLedgerAdjustmentRequestSchema }) body: CreateLedgerAdjustmentRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<LedgerAdjustment> {
    return this.adjustments.request(body, staffActorOf(user, client));
  }

  @Get(':adjustmentId')
  @RequirePermissions('adjustments.read')
  @ApiOperation({
    summary: 'View a manual adjustment',
    description:
      '`entryId` is the ledger entry of an approved adjustment; it is `null` otherwise. ' +
      'Requires `adjustments.read`.' +
      AUDITED,
  })
  @ApiParam(ADJUSTMENT_ID)
  @ApiOkResponse({ schema: toOpenApiSchema(ledgerAdjustmentSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 429)
  get(
    @Param('adjustmentId', { schema: uuidSchema }) adjustmentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<LedgerAdjustment> {
    return this.adjustments.get(adjustmentId, staffActorOf(user, client));
  }

  @Post(':adjustmentId/approve')
  @HttpCode(200)
  @RequirePermissions('adjustments.approve')
  @RequiresFeature('manualAdjustments')
  @ApiOperation({
    summary: 'Approve a manual adjustment',
    description:
      '**Moves the funds, at once and for good**: the ledger entry is posted in the same ' +
      'transaction as the approval — or nothing is. The approver must be a **different ' +
      'member of staff** from the author of the request, and cannot be the account holder. ' +
      'The database enforces the same rules, checks that both are still active and still ' +
      'entitled, and that the entry is the one of the adjustment.\n\n' +
      '**An open session is not enough**: present your `currentPassword` again, and your ' +
      'second factor — `code` or `recoveryCode`. The account holder is told by e-mail, ' +
      'without the reason, and finds the movement in the wallet (`kind`: ' +
      '`adjustment.credit` or `adjustment.debit`).\n\n' +
      'Answers `INSUFFICIENT_FUNDS` if the wallet no longer holds a debited amount — the ' +
      'request stays pending —, and `CONFLICT` if the request is no longer pending, has ' +
      'expired, or if the account was closed. Requires `adjustments.approve` and the ' +
      '`manualAdjustments` feature to be open.',
  })
  @ApiParam(ADJUSTMENT_ID)
  @ApiBody({ schema: toOpenApiInputSchema(approveLedgerAdjustmentRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(ledgerAdjustmentSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 422, 429)
  approve(
    @Param('adjustmentId', { schema: uuidSchema }) adjustmentId: string,
    @Body({ schema: approveLedgerAdjustmentRequestSchema }) body: ApproveLedgerAdjustmentRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<LedgerAdjustment> {
    return this.adjustments.approve(adjustmentId, body, user, staffActorOf(user, client).client);
  }

  @Post(':adjustmentId/reject')
  @HttpCode(200)
  @RequirePermissions('adjustments.approve')
  @ApiOperation({
    summary: 'Reject a manual adjustment',
    description:
      'Closes the request without moving anything; the `note` says why. Like an approval, a ' +
      'rejection comes from a second member of staff — the author of a request cancels it ' +
      'instead. Requires `adjustments.approve`.',
  })
  @ApiParam(ADJUSTMENT_ID)
  @ApiBody({ schema: toOpenApiInputSchema(rejectLedgerAdjustmentRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(ledgerAdjustmentSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429)
  reject(
    @Param('adjustmentId', { schema: uuidSchema }) adjustmentId: string,
    @Body({ schema: rejectLedgerAdjustmentRequestSchema }) body: RejectLedgerAdjustmentRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<LedgerAdjustment> {
    return this.adjustments.reject(adjustmentId, body, staffActorOf(user, client));
  }

  @Post(':adjustmentId/cancel')
  @HttpCode(200)
  @RequirePermissions('adjustments.request')
  @ApiOperation({
    summary: 'Cancel my manual adjustment request',
    description:
      'Only the author of a pending request can cancel it. Requires `adjustments.request`.',
  })
  @ApiParam(ADJUSTMENT_ID)
  @ApiOkResponse({ schema: toOpenApiSchema(ledgerAdjustmentSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429)
  cancel(
    @Param('adjustmentId', { schema: uuidSchema }) adjustmentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<LedgerAdjustment> {
    return this.adjustments.cancel(adjustmentId, staffActorOf(user, client));
  }
}
