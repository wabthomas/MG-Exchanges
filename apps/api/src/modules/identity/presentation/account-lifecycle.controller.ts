import {
  type AccountClosure,
  accountClosureSchema,
  type CloseAccountRequest,
  closeAccountRequestSchema,
  type DataExport,
  type DataExportRequest,
  dataExportRequestSchema,
  DATA_EXPORTS_PER_DAY,
  dataExportSchema,
} from '@mgx/contracts';
import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../../common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import {
  ApiProblemResponses,
  toOpenApiInputSchema,
  toOpenApiSchema,
} from '../../../common/http/openapi.js';
import { ReqContext, type RequestContext } from '../../../common/http/request-context.js';
import { AccountClosureService } from '../application/account-closure.service.js';
import { DataExportService } from '../application/data-export.service.js';

const HOLDER_PROOF =
  'Requires the current password and — if two-step verification is enabled on the account ' +
  '(`422` otherwise) — `code` or `recoveryCode`: an open session is not enough.';

/** Copie des données du compte et clôture, par son titulaire. */
@ApiTags('Account')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class AccountLifecycleController {
  constructor(
    private readonly exports: DataExportService,
    private readonly closures: AccountClosureService,
  ) {}

  @Post('data-export')
  @HttpCode(200)
  @Header('Content-Disposition', 'attachment; filename="mg-exchange-data.json"')
  @ApiOperation({
    summary: 'Get a copy of my data',
    description:
      `${HOLDER_PROOF} Returns, as one JSON document, what the platform holds about the ` +
      'account: account, declared profile, security settings, sessions, activity history and ' +
      'identity verification cases. It contains no secret; the number of an identity document ' +
      'is masked, and the files attached to verification cases are described, not included. ' +
      `At most ${String(DATA_EXPORTS_PER_DAY)} copies per 24 hours. Each copy is recorded in ` +
      'the activity history and reported to the holder by e-mail.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(dataExportRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(dataExportSchema) })
  @ApiProblemResponses(400, 401, 422, 429, 503)
  exportData(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: dataExportRequestSchema }) body: DataExportRequest,
    @ReqContext() client: RequestContext,
  ): Promise<DataExport> {
    return this.exports.export(user, body, client);
  }

  @Post('close')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Close my account',
    description:
      `**Immediate and permanent.** ${HOLDER_PROOF} \`confirm\` must be \`true\`.\n\n` +
      'The account can no longer sign in: its password, two-step verification, sessions and ' +
      'profile are erased at once, and its e-mail address and phone number are free for a new ' +
      'registration. Verification cases that were never reviewed are erased with their ' +
      'documents; those on which a decision was taken are kept until `legalRetentionUntil`, as ' +
      'the law requires. What remains is erased from `erasureDueAt`. The holder is told by ' +
      'e-mail.\n\nRefused (`409`) while the account holds a back-office role.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(closeAccountRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(accountClosureSchema) })
  @ApiProblemResponses(400, 401, 409, 422, 429)
  close(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: closeAccountRequestSchema }) body: CloseAccountRequest,
    @ReqContext() client: RequestContext,
  ): Promise<AccountClosure> {
    return this.closures.closeOwn(user, body, client);
  }
}
