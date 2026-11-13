import {
  type MfaStatus,
  mfaStatusSchema,
  type RecoveryCodes,
  type RecoveryCodesRegenerationRequest,
  recoveryCodesRegenerationRequestSchema,
  recoveryCodesSchema,
  type TotpConfirmationRequest,
  totpConfirmationRequestSchema,
  type TotpDisableRequest,
  totpDisableRequestSchema,
  type TotpEnrollment,
  type TotpEnrollmentRequest,
  totpEnrollmentRequestSchema,
  totpEnrollmentSchema,
} from '@mgx/contracts';
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../../common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import {
  ApiProblemResponses,
  toOpenApiInputSchema,
  toOpenApiSchema,
} from '../../../common/http/openapi.js';
import { ReqContext, type RequestContext } from '../../../common/http/request-context.js';
import { AllowDuringMaintenance } from '../../system-settings/presentation/access.decorators.js';
import { MfaService } from '../application/mfa.service.js';

/**
 * Validation en deux étapes. Accessible pendant la maintenance : le back-office l'exige, et
 * c'est par le back-office qu'on sort de la maintenance.
 */
@ApiTags('Two-step verification')
@ApiBearerAuth()
@AllowDuringMaintenance()
@Controller({ path: 'me/mfa', version: '1' })
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get()
  @ApiOperation({
    summary: 'Two-step verification status',
    description: 'Whether an authenticator app is set up, and how many recovery codes are left.',
  })
  @ApiOkResponse({ schema: toOpenApiSchema(mfaStatusSchema) })
  @ApiProblemResponses(401, 429)
  status(@CurrentUser() user: AuthenticatedUser): Promise<MfaStatus> {
    return this.mfa.status(user.userId);
  }

  @Post('totp/enroll')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start setting up an authenticator app',
    description:
      'Requires the current password. Returns the secret to add to an authenticator app ' +
      '(Google Authenticator, Authy, 1Password…): show `otpauthUri` as a QR code, or let the ' +
      'user type `secret`. **The secret is only shown here.** Nothing changes at sign-in until ' +
      'the setup is confirmed with a first code; calling this again replaces an unfinished setup.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(totpEnrollmentRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(totpEnrollmentSchema) })
  @ApiProblemResponses(400, 401, 409, 429)
  enroll(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: totpEnrollmentRequestSchema }) body: TotpEnrollmentRequest,
    @ReqContext() client: RequestContext,
  ): Promise<TotpEnrollment> {
    return this.mfa.startTotpEnrollment(user, body, client);
  }

  @Post('totp/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirm the authenticator app and enable two-step verification',
    description:
      'A valid code proves the app holds the secret. From then on every sign-in requires a ' +
      'second step, and **all other sessions are closed**. Returns 10 recovery codes, **shown ' +
      'only once**: each replaces the authenticator code a single time.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(totpConfirmationRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(recoveryCodesSchema) })
  @ApiProblemResponses(400, 401, 409, 429)
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: totpConfirmationRequestSchema }) body: TotpConfirmationRequest,
    @ReqContext() client: RequestContext,
  ): Promise<RecoveryCodes> {
    return this.mfa.confirmTotpEnrollment(user, body, client);
  }

  @Post('totp/disable')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Disable two-step verification',
    description:
      'Requires the current password **and** a second-factor proof: an authenticator code ' +
      '(`code`) or a recovery code (`recoveryCode`). Closes all other sessions. An account ' +
      'holding a back-office role loses access to the back office until it is enabled again.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(totpDisableRequestSchema) })
  @ApiNoContentResponse({ description: 'Two-step verification disabled.' })
  @ApiProblemResponses(400, 401, 409, 429)
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: totpDisableRequestSchema }) body: TotpDisableRequest,
    @ReqContext() client: RequestContext,
  ): Promise<void> {
    await this.mfa.disableTotp(user, body, client);
  }

  @Post('recovery-codes')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Generate new recovery codes',
    description:
      'Requires the current password and an authenticator code. Returns 10 new codes, shown ' +
      'only once; **the previous ones stop working**.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(recoveryCodesRegenerationRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(recoveryCodesSchema) })
  @ApiProblemResponses(400, 401, 409, 429)
  regenerateRecoveryCodes(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: recoveryCodesRegenerationRequestSchema })
    body: RecoveryCodesRegenerationRequest,
    @ReqContext() client: RequestContext,
  ): Promise<RecoveryCodes> {
    return this.mfa.regenerateRecoveryCodes(user, body, client);
  }
}
