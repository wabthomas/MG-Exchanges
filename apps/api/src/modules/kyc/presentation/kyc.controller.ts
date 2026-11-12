import {
  KYC_ADDRESS_PROOF_MAX_AGE_DAYS,
  KYC_DOCUMENT_CONTENT_TYPES,
  KYC_DOCUMENT_KINDS,
  KYC_DOCUMENT_MAX_BYTES,
  KYC_DRAFT_RETENTION_DAYS,
  type KycAddressDeclaration,
  kycAddressDeclarationSchema,
  type KycCase,
  kycCaseSchema,
  type KycDocumentUploadQuery,
  kycDocumentUploadQuerySchema,
  type KycFundsDeclaration,
  kycFundsDeclarationSchema,
  type KycIdentityDeclaration,
  kycIdentityDeclarationSchema,
  type KycOverview,
  kycOverviewSchema,
} from '@mgx/contracts';
import { uuidSchema } from '@mgx/validation';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUser } from '../../../common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import {
  ApiProblemResponses,
  toOpenApiInputSchema,
  toOpenApiSchema,
} from '../../../common/http/openapi.js';
import { type RawBodyLimits, readRawBody } from '../../../common/http/raw-body.js';
import { ReqContext, type RequestContext } from '../../../common/http/request-context.js';
import { RequiresFeature } from '../../system-settings/presentation/access.decorators.js';
import { KycUploadSlots } from '../application/kyc-upload-slots.js';
import { type KycActor, KycService } from '../application/kyc.service.js';
import { acceptedContentType, KYC_UPLOAD_RETRY_AFTER_SECONDS } from '../domain/kyc-policy.js';

/**
 * Réception d'une pièce : bornée en taille et en durée (voir `readRawBody`). Deux minutes
 * laissent passer la taille maximale sur une liaison mobile lente (≈ 350 kbit/s).
 */
export const KYC_UPLOAD_LIMITS: RawBodyLimits = {
  maxBytes: KYC_DOCUMENT_MAX_BYTES,
  discardUpToBytes: 4 * KYC_DOCUMENT_MAX_BYTES,
  timeoutMs: 120_000,
};

const MAX_MEBIBYTES = String(KYC_DOCUMENT_MAX_BYTES / (1024 * 1024));
const CASE_ID_PARAM = { name: 'caseId', schema: { type: 'string', format: 'uuid' } } as const;

const DRAFT_RULES =
  ' Saving creates the draft case of this level, or replaces the declaration of the existing ' +
  'draft; documents already attached are kept. Answers `CONFLICT` while a case of this level ' +
  'awaits review, or if the previous level is not verified yet. At most 30 saves per hour.';

function actorOf(user: AuthenticatedUser, client: RequestContext): KycActor {
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
 * Vérification d'identité du titulaire : un dossier par niveau, préparé, complété de ses
 * pièces, puis déposé. Réservée à la fonctionnalité `kyc` — désactivée par défaut.
 */
@ApiTags('Identity verification')
@ApiBearerAuth()
@RequiresFeature('kyc')
@Controller({ path: 'me/verification', version: '1' })
export class KycController {
  constructor(
    private readonly kyc: KycService,
    private readonly uploadSlots: KycUploadSlots,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'My verification status',
    description:
      'Verified level of the account (0 to 3) and, for each level, whether it is verified, ' +
      'whether a case can be prepared now, and the latest case. Levels are obtained in order: ' +
      '1 identity (identity document and selfie), 2 address (proof of address), 3 source of ' +
      'funds. Only individual accounts can be verified for now.',
  })
  @ApiOkResponse({ schema: toOpenApiSchema(kycOverviewSchema) })
  @ApiProblemResponses(401, 403, 429)
  overview(@CurrentUser() user: AuthenticatedUser): Promise<KycOverview> {
    return this.kyc.overview(user.userId);
  }

  @Put('identity')
  @ApiOperation({
    summary: 'Save my identity declaration (level 1)',
    description:
      'Names, birth, nationality and the identity document presented, **exactly as printed on ' +
      'the document**. The holder must be at least 18; the document must not be expired; a ' +
      'passport needs an expiry date; a voter card is only accepted when issued by DR Congo. ' +
      'The document number is stored encrypted and returned masked.' +
      DRAFT_RULES,
  })
  @ApiBody({ schema: toOpenApiInputSchema(kycIdentityDeclarationSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(kycCaseSchema) })
  @ApiProblemResponses(400, 401, 403, 409, 422, 429, 503)
  saveIdentity(
    @Body({ schema: kycIdentityDeclarationSchema }) body: KycIdentityDeclaration,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<KycCase> {
    return this.kyc.saveIdentity(actorOf(user, client), body);
  }

  @Put('address')
  @ApiOperation({
    summary: 'Save my address declaration (level 2)',
    description:
      'Residential address, in the country of the account, and the proof presented — dated ' +
      `at most ${String(KYC_ADDRESS_PROOF_MAX_AGE_DAYS)} days ago.` +
      DRAFT_RULES,
  })
  @ApiBody({ schema: toOpenApiInputSchema(kycAddressDeclarationSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(kycCaseSchema) })
  @ApiProblemResponses(400, 401, 403, 409, 422, 429)
  saveAddress(
    @Body({ schema: kycAddressDeclarationSchema }) body: KycAddressDeclaration,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<KycCase> {
    return this.kyc.saveAddress(actorOf(user, client), body);
  }

  @Put('source-of-funds')
  @ApiOperation({
    summary: 'Save my source-of-funds declaration (level 3)',
    description:
      'Where the money used on the platform comes from: one or more sources, occupation, ' +
      'employer if any, and an explanation in your own words.' +
      DRAFT_RULES,
  })
  @ApiBody({ schema: toOpenApiInputSchema(kycFundsDeclarationSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(kycCaseSchema) })
  @ApiProblemResponses(400, 401, 403, 409, 422, 429)
  saveFunds(
    @Body({ schema: kycFundsDeclarationSchema }) body: KycFundsDeclaration,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<KycCase> {
    return this.kyc.saveFunds(actorOf(user, client), body);
  }

  @Get('cases/:caseId')
  @ApiOperation({
    summary: 'One of my verification cases',
    description:
      'The declaration, the documents attached (description only: a document cannot be ' +
      'downloaded back), the documents still missing, and the decision once taken. A rejected ' +
      'case carries the reasons; the internal note of the reviewer is never returned.',
  })
  @ApiParam(CASE_ID_PARAM)
  @ApiOkResponse({ schema: toOpenApiSchema(kycCaseSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 429, 503)
  getCase(
    @Param('caseId', { schema: uuidSchema }) caseId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<KycCase> {
    return this.kyc.getCase(user.userId, caseId);
  }

  @Delete('cases/:caseId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Discard a draft case',
    description:
      'Erases a case that was never submitted, with its documents. A submitted case cannot be ' +
      `discarded. A draft left untouched for ${String(KYC_DRAFT_RETENTION_DAYS)} days is ` +
      'erased automatically.',
  })
  @ApiParam(CASE_ID_PARAM)
  @ApiNoContentResponse({ description: 'Draft erased.' })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429, 503)
  async discard(
    @Param('caseId', { schema: uuidSchema }) caseId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<void> {
    await this.kyc.discardDraft(actorOf(user, client), caseId);
  }

  @Post('cases/:caseId/documents')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Attach a document to a draft case',
    description:
      'Send **the file itself as the request body** (not a form), with its own ' +
      '`Content-Type`: `image/jpeg`, `image/png` or `application/pdf` — a selfie must be an ' +
      `image. At most ${MAX_MEBIBYTES} MiB. The content is checked against the declared type ` +
      'and stored encrypted.\n\n' +
      'Level 1 takes `IDENTITY_FRONT`, `IDENTITY_BACK` (required for an identity card, a ' +
      'voter card and a driving licence) and `SELFIE` — sending one again **replaces** it. ' +
      'Level 2 takes 1 to 3 `PROOF_OF_ADDRESS`; level 3 takes 1 to 5 `SOURCE_OF_FUNDS`. At ' +
      'most 40 uploads per hour. The whole file must arrive within two minutes: compress ' +
      'photographs before sending them. `SERVICE_UNAVAILABLE` with a `Retry-After` header ' +
      'means too many documents are being received at the moment: retry after that delay.',
  })
  @ApiParam(CASE_ID_PARAM)
  @ApiQuery({
    name: 'kind',
    required: true,
    schema: { type: 'string', enum: [...KYC_DOCUMENT_KINDS] },
  })
  @ApiConsumes(...KYC_DOCUMENT_CONTENT_TYPES)
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiCreatedResponse({ schema: toOpenApiSchema(kycCaseSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 408, 409, 413, 415, 422, 429, 503)
  async addDocument(
    @Param('caseId', { schema: uuidSchema }) caseId: string,
    @Query({ schema: kycDocumentUploadQuerySchema }) query: KycDocumentUploadQuery,
    @Headers('content-type') contentTypeHeader: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<KycCase> {
    const contentType = acceptedContentType(contentTypeHeader);
    if (contentType === null) {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        'Send the file itself as the request body, with its own content type: image/jpeg, ' +
          'image/png or application/pdf.',
      );
    }
    const actor = actorOf(user, client);
    // Rien n'est lu du corps tant que l'envoi n'est pas reconnu recevable.
    await this.kyc.prepareUpload(actor, caseId, query.kind);

    // Le fichier est gardé en mémoire le temps d'être chiffré : le nombre de réceptions
    // simultanées est borné, pour que les envois ne puissent pas épuiser la mémoire.
    const release = this.uploadSlots.tryAcquire();
    if (release === null) {
      // La réponse part sans lire le corps : la connexion ne peut pas être réutilisée.
      response.setHeader('Connection', 'close');
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Too many documents are being received at the moment. Please retry in a few seconds.',
        { retryAfterSeconds: KYC_UPLOAD_RETRY_AFTER_SECONDS },
      );
    }
    try {
      const content = await readRawBody(request, response, KYC_UPLOAD_LIMITS);
      return await this.kyc.addDocument(actor, caseId, query.kind, { contentType, content });
    } finally {
      release();
    }
  }

  @Delete('cases/:caseId/documents/:documentId')
  @ApiOperation({
    summary: 'Remove a document from a draft case',
    description: 'The file is erased. Only a draft case can be changed.',
  })
  @ApiParam(CASE_ID_PARAM)
  @ApiParam({ name: 'documentId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: toOpenApiSchema(kycCaseSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 429, 503)
  removeDocument(
    @Param('caseId', { schema: uuidSchema }) caseId: string,
    @Param('documentId', { schema: uuidSchema }) documentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<KycCase> {
    return this.kyc.removeDocument(actorOf(user, client), caseId, documentId);
  }

  @Post('cases/:caseId/submit')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Submit a case for review',
    description:
      'Freezes the case and queues it for review: it can no longer be changed or discarded. ' +
      'Answers `UNPROCESSABLE_ENTITY` if a document is missing or if the declaration is no ' +
      'longer valid (document expired since, proof of address now too old). The decision is ' +
      'notified by e-mail and shows in the account activity. At most 5 submissions per day.',
  })
  @ApiParam(CASE_ID_PARAM)
  @ApiOkResponse({ schema: toOpenApiSchema(kycCaseSchema) })
  @ApiProblemResponses(400, 401, 403, 404, 409, 422, 429, 503)
  submit(
    @Param('caseId', { schema: uuidSchema }) caseId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ReqContext() client: RequestContext,
  ): Promise<KycCase> {
    return this.kyc.submit(actorOf(user, client), caseId);
  }
}
