import {
  ADMIN_KYC_CASE_STATUSES,
  type AdminKycCase,
  type AdminKycCaseList,
  type AdminKycCaseListQuery,
  adminKycCaseListQuerySchema,
  adminKycCaseListSchema,
  adminKycCaseSchema,
  type ApproveKycCaseRequest,
  approveKycCaseRequestSchema,
  KYC_DOCUMENT_CONTENT_TYPES,
  KYC_LEVELS,
  type RejectKycCaseRequest,
  rejectKycCaseRequestSchema,
  type RevokeKycCaseRequest,
  revokeKycCaseRequestSchema,
} from '@mgx/contracts';
import { uuidSchema } from '@mgx/validation';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
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
import { AllowDuringMaintenance } from '../../system-settings/presentation/access.decorators.js';
import { type KycReviewer, KycReviewService } from '../application/kyc-review.service.js';

const CASE_ID_PARAM = { name: 'caseId', schema: { type: 'string', format: 'uuid' } } as const;

const REVIEW_RULES =
  '\n\nYou cannot review your own case. The decision is final, written to the audit log, and ' +
  'notified to the holder by e-mail — who never learns who decided.';

function reviewerOf(user: AuthenticatedUser, client: RequestContext): KycReviewer {
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
 * Back-office : examen des dossiers de vérification d'identité. Comme toute route
 * d'administration, exige une permission et la validation en deux étapes. Reste accessible
 * pendant la maintenance et lorsque la fonctionnalité `kyc` est fermée aux titulaires : la file
 * doit pouvoir être traitée, et une vérification frauduleuse retirée, à tout moment.
 */
@ApiTags('Administration')
@ApiBearerAuth()
@AllowDuringMaintenance()
@Controller({ path: 'admin/kyc/cases', version: '1' })
export class AdminKycController {
  constructor(private readonly review: KycReviewService) {}

  @Get()
  @RequirePermissions('kyc.read')
  @ApiOperation({
    summary: 'Browse verification cases',
    description:
      'Submitted cases, **oldest submission first** — by default those awaiting review ' +
      '(`status=SUBMITTED`). Filter by `status`, `level` or `userId`. Page with `after` = the ' +
      '`nextCursor` of the previous page. Draft cases are never visible to staff. Every page ' +
      'viewed is recorded in the audit log. Requires `kyc.read`.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    schema: { type: 'string', enum: [...ADMIN_KYC_CASE_STATUSES], default: 'SUBMITTED' },
  })
  @ApiQuery({
    name: 'level',
    required: false,
    schema: { type: 'integer', enum: [...KYC_LEVELS] },
  })
  @ApiQuery({ name: 'userId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'after', required: false, schema: { type: 'string' } })
  @ApiOkResponse({ schema: toOpenApiSchema(adminKycCaseListSchema) })
  @ApiProblemResponses(400, 401, 403, 429)
  list(
    @Query({ schema: adminKycCaseListQuerySchema }) query: AdminKycCaseListQuery,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminKycCaseList> {
    return this.review.list(query, reviewerOf(user, client));
  }

  @Get(':caseId')
  @RequirePermissions('kyc.read')
  @ApiOperation({
    summary: 'View a verification case',
    description:
      'The full declaration — including the complete identity document number —, the ' +
      'documents, and what helps to judge the case: the same file or the same identity ' +
      'document seen on **other accounts**, the approved case this one would replace, and the ' +
      'other cases of the account. Viewing a case is recorded in the audit log. Requires ' +
      '`kyc.read`.',
  })
  @ApiParam(CASE_ID_PARAM)
  @ApiOkResponse({ schema: toOpenApiSchema(adminKycCaseSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 429, 503)
  get(
    @Param('caseId', { schema: uuidSchema }) caseId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminKycCase> {
    return this.review.get(caseId, reviewerOf(user, client));
  }

  @Get(':caseId/documents/:documentId')
  @RequirePermissions('kyc.read')
  @ApiOperation({
    summary: 'Download a document of a verification case',
    description:
      'The decrypted file, as an attachment. Its integrity is checked against the digest ' +
      'taken when it was received. **Every download is recorded in the audit log** before ' +
      'the content is returned. Requires `kyc.read`.',
  })
  @ApiParam(CASE_ID_PARAM)
  @ApiParam({ name: 'documentId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({
    description: 'The document.',
    content: Object.fromEntries(
      KYC_DOCUMENT_CONTENT_TYPES.map((type) => [
        type,
        { schema: { type: 'string', format: 'binary' } },
      ]),
    ),
  })
  @ApiProblemResponses(400, 401, 403, 404, 429, 500, 503)
  async document(
    @Param('caseId', { schema: uuidSchema }) caseId: string,
    @Param('documentId', { schema: uuidSchema }) documentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<StreamableFile> {
    const file = await this.review.document(caseId, documentId, reviewerOf(user, client));
    return new StreamableFile(file.content, {
      type: file.contentType,
      // Toujours en pièce jointe : le contenu n'est jamais interprété dans l'origine de l'API.
      disposition: `attachment; filename="${file.fileName}"`,
      length: file.content.length,
    });
  }

  @Post(':caseId/approve')
  @HttpCode(200)
  @RequirePermissions('kyc.review')
  @ApiOperation({
    summary: 'Approve a verification case',
    description:
      'The level becomes verified, and what the case establishes (names and birth, or ' +
      'address) replaces what the holder declared in the profile. If an approved case of the ' +
      'same level was in force, it is superseded at the same instant. Answers `CONFLICT` if ' +
      'the case was already decided, or if **another account is already verified with the ' +
      'same identity document**. An internal `note` is optional. Requires `kyc.review`.' +
      REVIEW_RULES,
  })
  @ApiParam(CASE_ID_PARAM)
  @ApiBody({ required: false, schema: toOpenApiInputSchema(approveKycCaseRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(adminKycCaseSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429, 503)
  approve(
    @Param('caseId', { schema: uuidSchema }) caseId: string,
    @Body({ schema: approveKycCaseRequestSchema }) body: ApproveKycCaseRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminKycCase> {
    return this.review.approve(caseId, body, reviewerOf(user, client));
  }

  @Post(':caseId/reject')
  @HttpCode(200)
  @RequirePermissions('kyc.review')
  @ApiOperation({
    summary: 'Reject a verification case',
    description:
      'One to five `reasons`, **shown to the holder**, and an internal `note` (10 to 500 ' +
      'characters) that is never shown. The holder can then prepare a new case. Requires ' +
      '`kyc.review`.' +
      REVIEW_RULES,
  })
  @ApiParam(CASE_ID_PARAM)
  @ApiBody({ schema: toOpenApiInputSchema(rejectKycCaseRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(adminKycCaseSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429, 503)
  reject(
    @Param('caseId', { schema: uuidSchema }) caseId: string,
    @Body({ schema: rejectKycCaseRequestSchema }) body: RejectKycCaseRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminKycCase> {
    return this.review.reject(caseId, body, reviewerOf(user, client));
  }

  @Post(':caseId/revoke')
  @HttpCode(200)
  @RequirePermissions('kyc.revoke')
  @ApiOperation({
    summary: 'Revoke an approved verification',
    description:
      'Withdraws a verification in force (forged document, impersonation…). The verified ' +
      'level of the account falls below this level: higher levels, although still approved, ' +
      'no longer count until this one is verified again. The mandatory `reason` is internal; ' +
      'the holder is only told that the verification was withdrawn. Requires `kyc.revoke`.' +
      REVIEW_RULES,
  })
  @ApiParam(CASE_ID_PARAM)
  @ApiBody({ schema: toOpenApiInputSchema(revokeKycCaseRequestSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(adminKycCaseSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429, 503)
  revoke(
    @Param('caseId', { schema: uuidSchema }) caseId: string,
    @Body({ schema: revokeKycCaseRequestSchema }) body: RevokeKycCaseRequest,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<AdminKycCase> {
    return this.review.revoke(caseId, body, reviewerOf(user, client));
  }
}
