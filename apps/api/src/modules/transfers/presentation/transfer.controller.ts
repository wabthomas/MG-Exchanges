import {
  type CreateTransferRequest,
  createTransferRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  type Transfer,
  type TransferAllowanceList,
  transferAllowanceListSchema,
  type TransferList,
  type TransferListQuery,
  transferListQuerySchema,
  transferListSchema,
  transferSchema,
} from '@mgx/contracts';
import { uuidSchema } from '@mgx/validation';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentUser } from '../../../common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import {
  ApiProblemResponses,
  toOpenApiInputSchema,
  toOpenApiSchema,
} from '../../../common/http/openapi.js';
import { ReqContext, type RequestContext } from '../../../common/http/request-context.js';
import { RateLimit } from '../../../infrastructure/rate-limit/rate-limit.decorators.js';
import { RequiresFeature } from '../../system-settings/presentation/access.decorators.js';
import { TransferLimitsService } from '../application/transfer-limits.service.js';
import { TransferService } from '../application/transfer.service.js';
import { IdempotencyKey } from './idempotency-key.js';
import { TRANSFER_RATE_LIMIT } from './transfer-rate-limits.js';

const AMOUNTS =
  ' Amounts are **decimal strings** with exactly `asset.scale` decimals, never JSON numbers.';

/**
 * Transferts entre titulaires. Créer un transfert suppose que la fonctionnalité soit ouverte ;
 * consulter ses transferts et ses plafonds, non — un historique reste lisible si elle est
 * refermée. Comme toute route authentifiée, fermées au compte qui doit encore accepter les
 * conditions d'utilisation, et pendant la maintenance.
 */
@ApiTags('Transfers')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class TransferController {
  constructor(
    private readonly transfers: TransferService,
    private readonly limits: TransferLimitsService,
  ) {}

  @Post('transfers')
  @HttpCode(201)
  @RequiresFeature('internalTransfers')
  @RateLimit(TRANSFER_RATE_LIMIT)
  @ApiOperation({
    summary: 'Transfer funds to another account holder',
    description:
      '**Immediate and permanent.** Moves `amount` of `assetCode` from my wallet to the wallet ' +
      'of the holder whose e-mail address is `recipientEmail`. `amount` is a **decimal ' +
      'string** with at most `asset.scale` decimals, never a JSON number.\n\n' +
      '**Proof.** Requires the current password and — if two-step verification is enabled on ' +
      'the account (`422` otherwise) — `code` or `recoveryCode`: an open session is not ' +
      'enough.\n\n' +
      `**Idempotency.** The \`${IDEMPOTENCY_KEY_HEADER}\` header is mandatory: a value the ` +
      'client chooses — a UUID is fine — and sends again, unchanged, when it retries the same ' +
      'request. The transfer is then made once: the retry answers with the original transfer ' +
      `and the header \`${IDEMPOTENT_REPLAYED_HEADER}: true\`. The same key with a different ` +
      'recipient, asset or amount answers `IDEMPOTENCY_KEY_REUSED`. A request that was refused ' +
      'does not keep its key.\n\n' +
      '**Limits.** Those of my verification level in this asset, per transfer, over 24 hours ' +
      'and over 31 days (`GET /me/transfer-limits`): `TRANSFER_NOT_PERMITTED` if none is set ' +
      'for my level, `TRANSFER_LIMIT_EXCEEDED` if the amount exceeds one of them.\n\n' +
      '**Refusals** — nothing is moved: `INSUFFICIENT_FUNDS`; `RECIPIENT_UNAVAILABLE`, the ' +
      'same answer whether the address is unknown, the account closed or suspended, or its ' +
      'verification level not open in this asset — after too many of these, `429`; `422` ' +
      'when the recipient is my own account; `409` when the account changed during the ' +
      'request — send it again. At most 30 attempts per hour. Both parties are told by ' +
      'e-mail, and each sees the e-mail address of the other.',
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description: '16 to 128 characters: letters, digits, ".", "_", ":" or "-".',
    schema: { type: 'string', example: '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d' },
  })
  @ApiBody({ schema: toOpenApiInputSchema(createTransferRequestSchema) })
  @ApiCreatedResponse({
    schema: toOpenApiSchema(transferSchema),
    headers: {
      [IDEMPOTENT_REPLAYED_HEADER]: {
        description:
          'Present, with the value `true`, when the transfer had already been made under this ' +
          'idempotency key: nothing was moved again.',
        schema: { type: 'string', enum: ['true'] },
      },
    },
  })
  @ApiProblemResponses(400, 401, 403, 409, 422, 429, 503)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: createTransferRequestSchema }) body: CreateTransferRequest,
    @ReqContext() client: RequestContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Transfer> {
    const { replayed, transfer } = await this.transfers.create(user, body, idempotencyKey, client);
    // La réponse est celle de l'exécution d'origine ; l'en-tête dit que rien n'a été refait.
    if (replayed) {
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return transfer;
  }

  @Get('transfers')
  @ApiOperation({
    summary: 'My transfers',
    description:
      'Transfers I sent and received, **most recent first**. `direction` tells which; ' +
      '`counterparty.email` is the address the other account carries today — `null` once ' +
      'that account is closed. `entryId` is the ledger entry of the transfer: the wallet ' +
      'movement that carries the same `entryId` is this transfer. Page with `after` = the ' +
      '`nextCursor` of the previous page.' +
      AMOUNTS,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'after', required: false, schema: { type: 'string' } })
  @ApiOkResponse({ schema: toOpenApiSchema(transferListSchema) })
  @ApiProblemResponses(400, 401, 403, 429, 503)
  list(
    @Query({ schema: transferListQuerySchema }) query: TransferListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TransferList> {
    return this.transfers.list(user.userId, query);
  }

  @Get('transfers/:transferId')
  @ApiOperation({
    summary: 'One of my transfers',
    description:
      'Answers `NOT_FOUND` for a transfer I am neither the sender nor the recipient of.' + AMOUNTS,
  })
  @ApiParam({ name: 'transferId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: toOpenApiSchema(transferSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 429, 503)
  find(
    @Param('transferId', { schema: uuidSchema }) transferId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Transfer> {
    return this.transfers.find(user.userId, transferId);
  }

  @Get('transfer-limits')
  @ApiOperation({
    summary: 'What I may transfer',
    description:
      'For each asset the platform keeps, in the order of asset codes: the limits of my ' +
      'verification level (`level`) — per transfer, over the last 24 hours, over the last 31 ' +
      'days —, what I already sent in these two periods, and `remaining`, the largest amount ' +
      'the limits still allow right now, whatever my wallet holds. `limit` is `null` while no ' +
      'limit is set for my level in that asset: I can neither send nor receive it — nor can I ' +
      'when the limit per transfer is zero. `enabled` tells whether transfers between holders ' +
      'are open at all.' +
      AMOUNTS,
  })
  @ApiOkResponse({ schema: toOpenApiSchema(transferAllowanceListSchema) })
  @ApiProblemResponses(401, 403, 429, 503)
  allowances(@CurrentUser() user: AuthenticatedUser): Promise<TransferAllowanceList> {
    return this.limits.allowancesOf(user.userId);
  }
}
