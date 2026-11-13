import {
  type ActivityList,
  activityListSchema,
  type ActivityQuery,
  activityQuerySchema,
  type PhoneVerificationPending,
  phoneVerificationPendingSchema,
  type PhoneVerificationRequest,
  phoneVerificationRequestSchema,
  type Profile,
  profileSchema,
  type UpdateProfileRequest,
  updateProfileRequestSchema,
  type VerifyPhoneRequest,
  verifyPhoneRequestSchema,
} from '@mgx/contracts';
import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
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
import { RateLimit } from '../../../infrastructure/rate-limit/rate-limit.decorators.js';
import { ActivityService } from '../application/activity.service.js';
import { PhoneService } from '../application/phone.service.js';
import { ProfileService } from '../application/profile.service.js';
import { VERIFICATION_RATE_LIMIT } from './auth-rate-limits.js';

@ApiTags('Account')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class ProfileController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly phones: PhoneService,
    private readonly activity: ActivityService,
  ) {}

  // --- Profil ---------------------------------------------------------------------------------

  @Get('profile')
  @ApiOperation({
    summary: 'My profile',
    description:
      'Declared identity (given name, family name, `additionalName` for the Congolese ' +
      '"postnom"), address and preferences. These are **declared** values: nothing has ' +
      'verified them yet.',
  })
  @ApiOkResponse({ schema: toOpenApiSchema(profileSchema) })
  @ApiProblemResponses(401, 429)
  getProfile(@CurrentUser() user: AuthenticatedUser): Promise<Profile> {
    return this.profiles.get(user.userId);
  }

  @Patch('profile')
  @ApiOperation({
    summary: 'Update my profile',
    description:
      'Partial update: only the fields present change; `null` clears a field (`locale` cannot ' +
      'be cleared). The account holder must be at least 18 years old.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(updateProfileRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(profileSchema) })
  @ApiProblemResponses(400, 401, 429)
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: updateProfileRequestSchema }) body: UpdateProfileRequest,
    @ReqContext() client: RequestContext,
  ): Promise<Profile> {
    return this.profiles.update(user, body, client);
  }

  // --- Numéro de téléphone --------------------------------------------------------------------

  @Post('phone/verification')
  @RateLimit(VERIFICATION_RATE_LIMIT)
  @HttpCode(202)
  @ApiOperation({
    summary: 'Send a verification code to a phone number',
    description:
      'Texts a 6-digit code to the number. The number of the account only changes once the ' +
      'code is confirmed: until then, a previously verified number stays in place. Only mobile ' +
      'numbers of supported countries are accepted (currently DR Congo, `+243`). At most 3 ' +
      'codes per account every 15 minutes, and 3 per number every hour.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(phoneVerificationRequestSchema) })
  @ApiAcceptedResponse({ schema: toOpenApiSchema(phoneVerificationPendingSchema) })
  @ApiProblemResponses(400, 401, 409, 422, 429, 503)
  requestPhoneVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: phoneVerificationRequestSchema }) body: PhoneVerificationRequest,
    @ReqContext() client: RequestContext,
  ): Promise<PhoneVerificationPending> {
    return this.phones.requestVerification(user, body, client);
  }

  @Post('phone/verify')
  @RateLimit(VERIFICATION_RATE_LIMIT)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Confirm my phone number',
    description:
      'Confirms the number the last code was sent to; it becomes the verified number of the ' +
      'account. A code can be tried 5 times. Answers `CONFLICT` if the number is already ' +
      'verified on another account.',
  })
  @ApiBody({ schema: toOpenApiInputSchema(verifyPhoneRequestSchema) })
  @ApiNoContentResponse({ description: 'Phone number verified.' })
  @ApiProblemResponses(400, 401, 409, 429)
  async verifyPhone(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: verifyPhoneRequestSchema }) body: VerifyPhoneRequest,
    @ReqContext() client: RequestContext,
  ): Promise<void> {
    await this.phones.verify(user, body, client);
  }

  // --- Historique d'activité ------------------------------------------------------------------

  @Get('activity')
  @ApiOperation({
    summary: 'My account activity',
    description:
      'Security events of the account, most recent first: sign-ins (including failed ones), ' +
      'password and two-step verification changes, actions taken by support. Page with ' +
      '`before` = the `nextCursor` of the previous page.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'before', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: toOpenApiSchema(activityListSchema) })
  @ApiProblemResponses(400, 401, 429)
  listActivity(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: activityQuerySchema }) query: ActivityQuery,
  ): Promise<ActivityList> {
    return this.activity.list(user.userId, query);
  }
}
