import type { KycVerifiedLevel } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  type VerificationStatus,
  VerificationStatusReader,
  type VerifiedAddress,
  type VerifiedIdentity,
} from '../application/verification-status.reader.js';
import { verifiedLevelOf } from '../domain/verification-level.js';

/**
 * Lit ce que la vérification d'identité a établi dans les dossiers **acceptés en vigueur** —
 * au plus un par niveau (index unique de `kyc_cases`).
 */
@Injectable()
export class PrismaVerificationStatusReader extends VerificationStatusReader {
  async read(db: DbClient, userId: string): Promise<VerificationStatus> {
    const cases = await db.kycCase.findMany({
      where: { userId, status: 'APPROVED' },
      select: {
        level: true,
        givenName: true,
        familyName: true,
        additionalName: true,
        dateOfBirth: true,
        placeOfBirth: true,
        nationality: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        region: true,
        postalCode: true,
      },
    });

    let identity: VerifiedIdentity | null = null;
    let address: VerifiedAddress | null = null;
    for (const approved of cases) {
      if (
        approved.level === 1 &&
        approved.givenName !== null &&
        approved.familyName !== null &&
        approved.dateOfBirth !== null &&
        approved.placeOfBirth !== null &&
        approved.nationality !== null
      ) {
        identity = {
          givenName: approved.givenName,
          familyName: approved.familyName,
          additionalName: approved.additionalName,
          dateOfBirth: approved.dateOfBirth,
          placeOfBirth: approved.placeOfBirth,
          nationality: approved.nationality,
        };
      }
      if (approved.level === 2 && approved.addressLine1 !== null && approved.city !== null) {
        address = {
          addressLine1: approved.addressLine1,
          addressLine2: approved.addressLine2,
          city: approved.city,
          region: approved.region,
          postalCode: approved.postalCode,
        };
      }
    }
    const level = verifiedLevelOf(cases.map((approved) => approved.level));
    // Une adresse n'est vérifiée que pour une personne identifiée : si la vérification de
    // l'identité a été retirée, le dossier d'adresse, bien que toujours accepté, ne vaut plus.
    return { level, identity, address: level >= 2 ? address : null };
  }

  async level(db: DbClient, userId: string): Promise<KycVerifiedLevel> {
    const cases = await db.kycCase.findMany({
      where: { userId, status: 'APPROVED' },
      select: { level: true },
    });
    return verifiedLevelOf(cases.map(({ level }) => level));
  }
}
