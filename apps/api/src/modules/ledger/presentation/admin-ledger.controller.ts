import {
  type AdminAsset,
  type AdminAssetList,
  adminAssetListSchema,
  adminAssetSchema,
  type AdminLedgerAccountList,
  type AdminLedgerAccountListQuery,
  adminLedgerAccountListQuerySchema,
  adminLedgerAccountListSchema,
  type AdminLedgerEntry,
  adminLedgerEntrySchema,
  type AdminLedgerPostingList,
  type AdminLedgerPostingListQuery,
  adminLedgerPostingListQuerySchema,
  adminLedgerPostingListSchema,
  LEDGER_ACCOUNT_TYPE_KEYS,
  type RegisterAssetRequest,
  registerAssetRequestSchema,
  type TrialBalance,
  trialBalanceSchema,
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
import type { StaffActor } from '../../identity/application/admin-users.service.js';
import { AllowDuringMaintenance } from '../../system-settings/presentation/access.decorators.js';
import { LedgerAdministrationService } from '../application/ledger-administration.service.js';

const LIMIT_QUERY = {
  name: 'limit',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
} as const;
const AFTER_QUERY = { name: 'after', required: false, schema: { type: 'string' } } as const;

const AMOUNTS =
  ' Amounts are **decimal strings** with exactly `asset.scale` decimals, never JSON numbers.';
const AUDITED = ' Every consultation is recorded in the audit log. Requires `ledger.read`.';

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
 * Back-office : grand livre. Consultation des actifs, des comptes, des écritures et de la
 * balance ; enregistrement des actifs. **Aucune route ne passe d'écriture.** Reste accessible
 * pendant la maintenance — c'est le moment où l'on vérifie les comptes. Comme toute route
 * d'administration, exige une permission et la validation en deux étapes.
 */
@ApiTags('Administration')
@ApiBearerAuth()
@AllowDuringMaintenance()
@Controller({ path: 'admin/ledger', version: '1' })
export class AdminLedgerController {
  constructor(private readonly administration: LedgerAdministrationService) {}

  @Get('assets')
  @RequirePermissions('ledger.read')
  @ApiOperation({
    summary: 'List the assets of the ledger',
    description:
      'Every asset in which the platform keeps accounts, in the order of their codes, with ' +
      'who registered it and when. `registeredBy` is `null` for an asset registered outside ' +
      'the API.' +
      AUDITED,
  })
  @ApiOkResponse({ schema: toOpenApiSchema(adminAssetListSchema) })
  @ApiProblemResponses(401, 403, 429)
  listAssets(
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminAssetList> {
    return this.administration.listAssets(staffOf(user, client));
  }

  @Post('assets')
  @HttpCode(201)
  @RequirePermissions('ledger.manage_assets')
  @ApiOperation({
    summary: 'Register an asset',
    description:
      '**Permanent.** A registered asset is never changed nor removed: every amount of the ' +
      'ledger is an integer number of its smallest unit, so its number of decimals — `scale`: ' +
      '2 for USD and CDF, 8 for BTC, 18 at most — can never change, and neither can its code, ' +
      'its kind or its name. Check them twice. Registering an asset moves no funds and opens ' +
      'no operation: it only gives every account holder an empty wallet in that asset. ' +
      'Answers `CONFLICT` if the code is already registered.\n\n' +
      'The mandatory `reason` is written to the audit log. Requires `ledger.manage_assets`.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(registerAssetRequestSchema) })
  @ApiCreatedResponse({ schema: toOpenApiSchema(adminAssetSchema) })
  @ApiProblemResponses(400, 401, 403, 409, 429)
  registerAsset(
    @Body({ schema: registerAssetRequestSchema }) body: RegisterAssetRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminAsset> {
    return this.administration.registerAsset(body, staffOf(user, client));
  }

  @Get('accounts')
  @RequirePermissions('ledger.read')
  @ApiOperation({
    summary: 'Browse ledger accounts',
    description:
      'Accounts of account holders and of the platform itself, **oldest first**. Filter by ' +
      '`userId`, `assetCode` or `type`. An account is opened by the first entry posted to it: ' +
      'a holder with no account in an asset simply holds nothing in it. `balance` is ' +
      'expressed on the normal side of the account (`normalSide`) and is never negative. Page ' +
      'with `after` = the `nextCursor` of the previous page.' +
      AMOUNTS +
      AUDITED,
  })
  @ApiQuery({ name: 'userId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'assetCode', required: false, schema: { type: 'string', example: 'USD' } })
  @ApiQuery({
    name: 'type',
    required: false,
    schema: { type: 'string', enum: [...LEDGER_ACCOUNT_TYPE_KEYS] },
  })
  @ApiQuery(LIMIT_QUERY)
  @ApiQuery(AFTER_QUERY)
  @ApiOkResponse({ schema: toOpenApiSchema(adminLedgerAccountListSchema) })
  @ApiProblemResponses(400, 401, 403, 429)
  listAccounts(
    @Query({ schema: adminLedgerAccountListQuerySchema }) query: AdminLedgerAccountListQuery,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminLedgerAccountList> {
    return this.administration.listAccounts(query, staffOf(user, client));
  }

  @Get('accounts/:accountId/postings')
  @RequirePermissions('ledger.read')
  @ApiOperation({
    summary: 'View a ledger account and its postings',
    description:
      'The account and the lines posted to it, **most recent first**. `accountSequence` ' +
      'numbers the lines of the account 1, 2, 3… without a gap, and `balanceAfter` is the ' +
      'balance right after each line: the first line of the first page carries the balance ' +
      'of the account. Page with `after` = the `nextCursor` of the previous page.' +
      AMOUNTS +
      AUDITED,
  })
  @ApiParam({ name: 'accountId', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery(LIMIT_QUERY)
  @ApiQuery(AFTER_QUERY)
  @ApiOkResponse({ schema: toOpenApiSchema(adminLedgerPostingListSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 429)
  listPostings(
    @Param('accountId', { schema: uuidSchema }) accountId: string,
    @Query({ schema: adminLedgerPostingListQuerySchema }) query: AdminLedgerPostingListQuery,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminLedgerPostingList> {
    return this.administration.listPostings(accountId, query, staffOf(user, client));
  }

  @Get('entries/:entryId')
  @RequirePermissions('ledger.read')
  @ApiOperation({
    summary: 'View a ledger entry',
    description:
      'The whole entry: who posted it, for which operation (`kind`, `metadata`), under which ' +
      'idempotency key, and all its lines in order. For each asset, the debits of an entry ' +
      'equal its credits. An entry is never changed nor deleted: a mistake is corrected by a ' +
      'reverse entry.' +
      AMOUNTS +
      AUDITED,
  })
  @ApiParam({ name: 'entryId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: toOpenApiSchema(adminLedgerEntrySchema) })
  @ApiProblemResponses(400, 401, 403, 404, 429)
  getEntry(
    @Param('entryId', { schema: uuidSchema }) entryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminLedgerEntry> {
    return this.administration.getEntry(entryId, staffOf(user, client));
  }

  @Get('trial-balance')
  @RequirePermissions('ledger.read')
  @ApiOperation({
    summary: 'Trial balance of the ledger',
    description:
      'For each asset, the total of the balances per account type. `debitBalance` adds the ' +
      'accounts whose balance grows on the debit side — what the platform holds for its ' +
      'account holders; `creditBalance`, those that grow on the credit side — what it owes ' +
      'them, and what it earned. The two are equal (`balanced`) as long as the ledger is ' +
      'sound: a difference means the ledger was altered outside the application. The same ' +
      'verification, and deeper ones, also run every hour.' +
      AMOUNTS +
      AUDITED,
  })
  @ApiOkResponse({ schema: toOpenApiSchema(trialBalanceSchema) })
  @ApiProblemResponses(401, 403, 429)
  trialBalance(
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<TrialBalance> {
    return this.administration.trialBalance(staffOf(user, client));
  }
}
