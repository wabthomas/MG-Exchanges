import {
  type WalletList,
  walletListSchema,
  type WalletMovementList,
  type WalletMovementListQuery,
  walletMovementListQuerySchema,
  walletMovementListSchema,
} from '@mgx/contracts';
import { assetCodeSchema } from '@mgx/validation';
import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../../common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { ApiProblemResponses, toOpenApiSchema } from '../../../common/http/openapi.js';
import { WalletService } from '../application/wallet.service.js';

/**
 * Portefeuilles du titulaire : ses soldes et ses mouvements, tels que le grand livre les tient.
 * **Lecture seule** : aucune route ne déplace de fonds. Comme toute route authentifiée, fermée
 * au compte qui doit encore accepter les conditions d'utilisation, et pendant la maintenance.
 */
@ApiTags('Wallets')
@ApiBearerAuth()
@Controller({ path: 'me/wallets', version: '1' })
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Get()
  @ApiOperation({
    summary: 'My wallets',
    description:
      'One wallet per asset in which the platform keeps accounts, in the order of asset codes ' +
      '— at zero until funds are posted to it. The list is empty while no asset is registered. ' +
      '`available` is a **decimal string** with exactly `asset.scale` decimals, never a JSON ' +
      'number. Read-only: no route moves funds yet.',
  })
  @ApiOkResponse({ schema: toOpenApiSchema(walletListSchema) })
  @ApiProblemResponses(401, 403, 429, 503)
  list(@CurrentUser() user: AuthenticatedUser): Promise<WalletList> {
    return this.wallets.list(user.userId);
  }

  @Get(':assetCode/movements')
  @ApiOperation({
    summary: 'Movements of one of my wallets',
    description:
      '**Most recent first.** Each movement is one line of a ledger entry: `CREDIT` — funds ' +
      'came in; `DEBIT` — funds went out. `amount` is always positive; `balanceAfter` is the ' +
      'balance of the wallet right after the movement, so the first movement of the first ' +
      'page carries the current balance (`wallet.available`). `kind` names the operation that ' +
      'produced the entry; movements that share an `entryId` belong to the same operation. ' +
      'Page with `after` = the `nextCursor` of the previous page. Answers `NOT_FOUND` for an ' +
      'asset the platform does not keep.',
  })
  @ApiParam({ name: 'assetCode', schema: { type: 'string', example: 'USD' } })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'after', required: false, schema: { type: 'string' } })
  @ApiOkResponse({ schema: toOpenApiSchema(walletMovementListSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 429, 503)
  movements(
    @Param('assetCode', { schema: assetCodeSchema }) assetCode: string,
    @Query({ schema: walletMovementListQuerySchema }) query: WalletMovementListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WalletMovementList> {
    return this.wallets.movements(user.userId, assetCode, query);
  }
}
