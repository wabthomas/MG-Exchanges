import type { FeatureKey } from '@mgx/contracts';
import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';

import { ALLOW_DURING_MAINTENANCE_KEY, REQUIRED_FEATURE_KEY } from './access.metadata.js';
import { FeatureEnabledGuard } from './feature-enabled.guard.js';

/** Laisse la route (ou le contrôleur) accessible lorsque la plateforme est en maintenance. */
export const AllowDuringMaintenance = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_DURING_MAINTENANCE_KEY, true);

/**
 * Réserve la route (ou le contrôleur) à une fonctionnalité activée. Tant que celle-ci est
 * désactivée — l'état par défaut —, toute requête reçoit l'erreur `FEATURE_DISABLED`.
 */
export const RequiresFeature = (feature: FeatureKey): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(REQUIRED_FEATURE_KEY, feature), UseGuards(FeatureEnabledGuard));
