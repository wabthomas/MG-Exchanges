import {
  type SystemSettingList,
  systemSettingListSchema,
  type SystemSettingView,
  systemSettingViewSchema,
  type UpdateSystemSettingRequest,
  updateSystemSettingRequestSchema,
} from '@mgx/contracts';
import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';

import { CurrentUser, RequirePermissions } from '../../../common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import {
  ApiProblemResponses,
  toOpenApiInputSchema,
  toOpenApiSchema,
} from '../../../common/http/openapi.js';
import { ReqContext, type RequestContext } from '../../../common/http/request-context.js';
import { SystemSettingsService } from '../application/system-settings.service.js';
import { isSettingKey, SETTING_KEYS } from '../domain/setting-definitions.js';
import { AllowDuringMaintenance } from './access.decorators.js';

/**
 * Administration des paramètres de la plateforme : mode maintenance et ouverture des
 * fonctionnalités réglementées. Accessible pendant la maintenance — c'est par ici qu'on en sort.
 */
@ApiTags('Administration')
@ApiBearerAuth()
@AllowDuringMaintenance()
@Controller({ path: 'admin/system-settings', version: '1' })
export class AdminSystemSettingsController {
  constructor(private readonly settings: SystemSettingsService) {}

  @Get()
  @RequirePermissions('system_settings.read')
  @ApiOperation({
    summary: 'List platform settings',
    description:
      'Every setting with the value in force. `isDefault` is true while no decision has been ' +
      'recorded: features are then closed. Requires `system_settings.read`.',
  })
  @ApiOkResponse({ schema: toOpenApiSchema(systemSettingListSchema) })
  @ApiProblemResponses(401, 403, 429)
  async list(): Promise<SystemSettingList> {
    return { settings: await this.settings.describeAll() };
  }

  @Put(':key')
  @RequirePermissions('system_settings.write')
  @ApiOperation({
    summary: 'Change a platform setting',
    description:
      'Opens or closes a feature (`features.*`, boolean value) or sets the maintenance mode ' +
      '(`maintenance.mode`). The change, its author and the mandatory `reason` are written to ' +
      'the audit log in the same transaction. Requires `system_settings.write`.\n\n' +
      'Opening a regulated feature is a business decision: technical availability is not a ' +
      'legal authorisation.',
  })
  @ApiParam({
    name: 'key',
    description: `One of: ${SETTING_KEYS.map((key) => `\`${key}\``).join(', ')}.`,
  })
  @ApiBody({ schema: toOpenApiInputSchema(updateSystemSettingRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(systemSettingViewSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 422, 429)
  async update(
    @Param('key', { schema: z.string().min(1).max(128) }) key: string,
    @Body({ schema: updateSystemSettingRequestSchema }) body: UpdateSystemSettingRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<SystemSettingView> {
    if (!isSettingKey(key)) {
      throw new AppError('NOT_FOUND', 'Unknown setting.');
    }
    await this.settings.set(key, body.value, {
      actor: { type: 'USER', id: user.userId },
      requestId: client.requestId,
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
      reason: body.reason,
    });
    return this.settings.describe(key);
  }
}
