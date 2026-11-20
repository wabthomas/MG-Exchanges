import {
  type AuthenticatedLogin,
  authenticatedLoginSchema,
  type ChangePasswordRequest,
  changePasswordRequestSchema,
  type EmailOnlyRequest,
  emailOnlyRequestSchema,
  type LoginRequest,
  loginRequestSchema,
  type LoginResponse,
  loginResponseSchema,
  type MfaLoginRequest,
  mfaLoginRequestSchema,
  type PasswordResetPending,
  passwordResetPendingSchema,
  type RefreshRequest,
  refreshRequestSchema,
  type RefreshResponse,
  refreshResponseSchema,
  type RegisterRequest,
  registerRequestSchema,
  type ResetPasswordRequest,
  resetPasswordRequestSchema,
  type VerificationPending,
  verificationPendingSchema,
  type VerifyEmailRequest,
  verifyEmailRequestSchema,
} from '@mgx/contracts';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  AllowBeforeTermsAcceptance,
  CurrentUser,
  Public,
} from '../../../common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import {
  ApiProblemResponses,
  toOpenApiInputSchema,
  toOpenApiSchema,
} from '../../../common/http/openapi.js';
import { ReqContext, type RequestContext } from '../../../common/http/request-context.js';
import { RateLimit } from '../../../infrastructure/rate-limit/rate-limit.decorators.js';
import {
  AllowDuringMaintenance,
  RequiresFeature,
} from '../../system-settings/presentation/access.decorators.js';
import { AuthenticationService } from '../application/authentication.service.js';
import { PasswordService } from '../application/password.service.js';
import { RegistrationService } from '../application/registration.service.js';
import {
  LOGIN_RATE_LIMIT,
  REGISTRATION_RATE_LIMIT,
  VERIFICATION_RATE_LIMIT,
} from './auth-rate-limits.js';

const SAME_ANSWER =
  'The answer is the same whether or not an account exists for this address, so that the ' +
  'endpoint cannot be used to find out who has an account.';

@ApiTags('Authentication')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly authentication: AuthenticationService,
    private readonly passwords: PasswordService,
  ) {}

  // --- Inscription --------------------------------------------------------------------------

  @Post('register')
  @Public()
  @RequiresFeature('registration')
  @RateLimit(REGISTRATION_RATE_LIMIT)
  @HttpCode(202)
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Creates an individual account and e-mails a 6-digit verification code. The account ' +
      'cannot sign in until the address is verified. Signing up again with an address whose ' +
      `sign-up was never completed replaces it entirely. ${SAME_ANSWER}\n\n` +
      'Signing up accepts the terms of use in force: `acceptedTermsVersion` is the `number` ' +
      'of the version the person was shown (`GET /terms/current`). If another version has ' +
      'been published since, the request is refused (`409 TERMS_VERSION_NOT_CURRENT`): show ' +
      'the current version and try again. Until a first version is published, nobody can ' +
      'sign up (`503 SERVICE_UNAVAILABLE`).\n\n' +
      'Requires the `registration` feature to be open.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(registerRequestSchema) })
  @ApiAcceptedResponse({ schema: toOpenApiSchema(verificationPendingSchema) })
  @ApiProblemResponses(400, 403, 409, 422, 429, 503)
  register(
    @Body({ schema: registerRequestSchema }) body: RegisterRequest,
    @ReqContext() client: RequestContext,
  ): Promise<VerificationPending> {
    return this.registration.register(body, client);
  }

  @Post('email/verify')
  @Public()
  @RequiresFeature('registration')
  @RateLimit(VERIFICATION_RATE_LIMIT)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Verify the e-mail address',
    description:
      'Confirms the address with the code received by e-mail **and the password chosen at ' +
      'sign-up**, and activates the account: only the person who both receives the code and ' +
      'chose the password can activate it. A code can be tried 5 times; a wrong code answers ' +
      '`INVALID_OR_EXPIRED_CODE`, whatever its cause. A right code with another password ' +
      'answers `INVALID_CREDENTIALS`: sign up again to replace the unfinished sign-up.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(verifyEmailRequestSchema) })
  @ApiNoContentResponse({ description: 'Address verified. The account can now sign in.' })
  @ApiProblemResponses(400, 401, 403, 429)
  async verifyEmail(
    @Body({ schema: verifyEmailRequestSchema }) body: VerifyEmailRequest,
    @ReqContext() client: RequestContext,
  ): Promise<void> {
    await this.registration.verifyEmail(body, client);
  }

  @Post('email/resend')
  @Public()
  @RequiresFeature('registration')
  @RateLimit(VERIFICATION_RATE_LIMIT)
  @HttpCode(202)
  @ApiOperation({
    summary: 'Send a new verification code',
    description: `Replaces the previous code. At most 3 codes per account every 15 minutes. ${SAME_ANSWER}`,
  })
  @ApiBody({ schema: toOpenApiInputSchema(emailOnlyRequestSchema) })
  @ApiAcceptedResponse({ schema: toOpenApiSchema(verificationPendingSchema) })
  @ApiProblemResponses(400, 403, 429, 503)
  resendEmailVerification(
    @Body({ schema: emailOnlyRequestSchema }) body: EmailOnlyRequest,
    @ReqContext() client: RequestContext,
  ): Promise<VerificationPending> {
    return this.registration.resendEmailVerification(body, client);
  }

  // --- Sessions -----------------------------------------------------------------------------

  @Post('login')
  @Public()
  @AllowDuringMaintenance()
  @RateLimit(LOGIN_RATE_LIMIT)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Opens a session and returns its tokens. Send the access token with every request ' +
      '(`Authorization: Bearer <accessToken>`); use the refresh token to obtain a new pair ' +
      'before the access token expires.\n\n' +
      '**Read `status`.** `AUTHENTICATED`: the session is open. `MFA_REQUIRED`: the account ' +
      'is protected by two-step verification and no session is open yet — send `mfaToken` and ' +
      'a code to `POST /auth/mfa/verify` within 5 minutes.\n\n' +
      'Send a stable random `deviceId` (created once per installation): a sign-in from a ' +
      'device the account has never used is reported to its holder by e-mail.\n\n' +
      'A wrong e-mail or a wrong password both answer `INVALID_CREDENTIALS`. After 5 failures ' +
      'in 15 minutes the client is blocked for 15 minutes (`RATE_LIMITED`, see `Retry-After`). ' +
      '`EMAIL_NOT_VERIFIED` and `ACCOUNT_DISABLED` (suspended account) are only returned when ' +
      'the password is correct. A closed account no longer exists: its former address answers ' +
      '`INVALID_CREDENTIALS`.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(loginRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(loginResponseSchema) })
  @ApiProblemResponses(400, 401, 403, 429)
  login(
    @Body({ schema: loginRequestSchema }) body: LoginRequest,
    @ReqContext() client: RequestContext,
  ): Promise<LoginResponse> {
    return this.authentication.login(body, client);
  }

  @Post('mfa/verify')
  @Public()
  @AllowDuringMaintenance()
  @RateLimit(LOGIN_RATE_LIMIT)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Complete a sign-in with the second step',
    description:
      'Second step of a sign-in that answered `MFA_REQUIRED`: the `mfaToken`, and either the ' +
      '6-digit `code` of the authenticator app or a `recoveryCode` (single use). Opens the ' +
      'session.\n\n' +
      'A code is accepted once. A wrong code answers `INVALID_OR_EXPIRED_CODE`; after 5 wrong ' +
      'codes the token is void (`UNAUTHENTICATED`: sign in again) and the second step of the ' +
      'account is blocked for 15 minutes (`RATE_LIMITED`).',
  })
  @ApiBody({ schema: toOpenApiInputSchema(mfaLoginRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(authenticatedLoginSchema) })
  @ApiProblemResponses(400, 401, 429)
  verifySecondFactor(
    @Body({ schema: mfaLoginRequestSchema }) body: MfaLoginRequest,
    @ReqContext() client: RequestContext,
  ): Promise<AuthenticatedLogin> {
    return this.authentication.completeMfaLogin(body, client);
  }

  @Post('refresh')
  @Public()
  @AllowDuringMaintenance()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Renew the session tokens',
    description:
      'Exchanges the refresh token for a new pair. **The refresh token changes at every call**: ' +
      'store the new one. Presenting a refresh token that was already used revokes the whole ' +
      'session (it means the token was copied), except within a few seconds of its use, to ' +
      'tolerate a lost response.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(refreshRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(refreshResponseSchema) })
  @ApiProblemResponses(400, 401, 429)
  refresh(
    @Body({ schema: refreshRequestSchema }) body: RefreshRequest,
    @ReqContext() client: RequestContext,
  ): Promise<RefreshResponse> {
    return this.authentication.refresh(body, client);
  }

  @Post('logout')
  @AllowDuringMaintenance()
  @AllowBeforeTermsAcceptance()
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out', description: 'Closes the current session immediately.' })
  @ApiNoContentResponse({ description: 'Session closed.' })
  @ApiProblemResponses(401, 429)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<void> {
    await this.authentication.logout(user, client);
  }

  // --- Mot de passe ---------------------------------------------------------------------------

  @Post('password/forgot')
  @Public()
  @RateLimit(VERIFICATION_RATE_LIMIT)
  @HttpCode(202)
  @ApiOperation({
    summary: 'Request a password reset',
    description:
      `E-mails a 6-digit reset code. ${SAME_ANSWER} An address whose sign-up was never ` +
      'completed receives an invitation to sign up again instead.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(emailOnlyRequestSchema) })
  @ApiAcceptedResponse({ schema: toOpenApiSchema(passwordResetPendingSchema) })
  @ApiProblemResponses(400, 429, 503)
  forgotPassword(
    @Body({ schema: emailOnlyRequestSchema }) body: EmailOnlyRequest,
    @ReqContext() client: RequestContext,
  ): Promise<PasswordResetPending> {
    return this.passwords.requestReset(body, client);
  }

  @Post('password/reset')
  @Public()
  @RateLimit(VERIFICATION_RATE_LIMIT)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Set a new password with a reset code',
    description:
      'Replaces the password and **closes every session** of the account. Two-step ' +
      'verification, if enabled, stays in place. A code can be tried 5 times; every failure ' +
      'answers `INVALID_OR_EXPIRED_CODE`.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(resetPasswordRequestSchema) })
  @ApiNoContentResponse({ description: 'Password replaced. Sign in again.' })
  @ApiProblemResponses(400, 429)
  async resetPassword(
    @Body({ schema: resetPasswordRequestSchema }) body: ResetPasswordRequest,
    @ReqContext() client: RequestContext,
  ): Promise<void> {
    await this.passwords.reset(body, client);
  }

  @Post('password/change')
  @AllowBeforeTermsAcceptance()
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change the password',
    description:
      'Requires the current password. Closes every **other** session of the account; the ' +
      'current one stays open.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(changePasswordRequestSchema) })
  @ApiNoContentResponse({ description: 'Password changed.' })
  @ApiProblemResponses(400, 401, 429)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: changePasswordRequestSchema }) body: ChangePasswordRequest,
    @ReqContext() client: RequestContext,
  ): Promise<void> {
    await this.passwords.change(user, body, client);
  }
}
