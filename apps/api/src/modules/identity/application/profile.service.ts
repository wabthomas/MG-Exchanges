import type { Profile, UpdateProfileRequest } from '@mgx/contracts';
import { localeSchema } from '@mgx/validation';
import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import {
  BIRTH_DATE_REJECTION_MESSAGES,
  checkBirthDate,
  formatCalendarDate,
  parseCalendarDate,
} from '../domain/profile-policy.js';
import type { ClientContext } from './client-context.js';
import { effectiveProfileOf, lockedProfileFields } from './effective-profile.js';
import { type ProfileFields, ProfileRepository } from './profile.repository.js';
import { UserRepository } from './user.repository.js';
import { VerificationStatusReader } from './verification-status.reader.js';

function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', 'Authentication is required.');
}

/**
 * Profil d'un compte : identité, adresse, préférences.
 *
 * Ces informations sont **déclaratives** tant que la vérification d'identité (KYC) ne les a
 * pas établies. Ce qu'un dossier de vérification accepté établit prime ensuite sur ce qui est
 * déclaré ici, et ne se modifie plus par cette voie : en changer passe par un nouveau dossier.
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly users: UserRepository,
    private readonly verification: VerificationStatusReader,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(userId: string): Promise<Profile> {
    const [user, declared, verification] = await Promise.all([
      this.users.findById(this.prisma, userId),
      this.profiles.find(this.prisma, userId),
      this.verification.read(this.prisma, userId),
    ]);
    if (user === null) {
      throw unauthenticated();
    }
    const { dateOfBirth, ...profile } = effectiveProfileOf(declared, verification);
    return {
      ...profile,
      dateOfBirth: dateOfBirth === null ? null : formatCalendarDate(dateOfBirth),
      locale: localeSchema.catch('fr').parse(user.locale),
      updatedAt: declared?.updatedAt.toISOString() ?? null,
    };
  }

  async update(
    auth: AuthenticatedUser,
    request: UpdateProfileRequest,
    client: ClientContext,
  ): Promise<Profile> {
    const { locale, dateOfBirth, ...text } = request;

    // Ce que la vérification d'identité a établi ne se modifie plus ici.
    const locked = lockedProfileFields(
      request,
      await this.verification.read(this.prisma, auth.userId),
    );
    if (locked.length > 0) {
      throw new AppError(
        'CONFLICT',
        'Verified information cannot be changed here: submit a new identity verification instead.',
        { errors: locked.map((path) => ({ path, message: 'Has been verified.' })) },
      );
    }

    let birthDate: Date | null | undefined;
    if (dateOfBirth !== undefined && dateOfBirth !== null) {
      const rejection = checkBirthDate(dateOfBirth, new Date());
      if (rejection !== null) {
        throw new AppError('VALIDATION_FAILED', 'Request validation failed.', {
          errors: [{ path: 'dateOfBirth', message: BIRTH_DATE_REJECTION_MESSAGES[rejection] }],
        });
      }
      birthDate = parseCalendarDate(dateOfBirth);
    } else {
      birthDate = dateOfBirth;
    }

    // Seuls les champs présents dans la requête changent ; `null` efface.
    const changes: Partial<ProfileFields> = {
      ...Object.fromEntries(Object.entries(text).filter(([, value]) => value !== undefined)),
      ...(birthDate === undefined ? {} : { dateOfBirth: birthDate }),
    };

    await this.unitOfWork.run(async (tx) => {
      if (Object.keys(changes).length > 0) {
        await this.profiles.save(tx, auth.userId, changes);
      }
      if (locale !== undefined) {
        await this.users.updateLocale(tx, auth.userId, locale);
      }
      // Le journal retient **quels** champs ont changé, pas leur contenu : ce sont des
      // données personnelles, qui n'ont pas à être recopiées dans un journal permanent.
      await this.audit.record(tx, {
        actor: { type: 'USER', id: auth.userId },
        action: 'user.profile_updated',
        resource: { type: 'user', id: auth.userId },
        outcome: 'SUCCESS',
        ...client,
        metadata: { fields: Object.keys(request).sort() },
      });
    });
    return this.get(auth.userId);
  }
}
