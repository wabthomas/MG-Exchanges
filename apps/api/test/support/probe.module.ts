import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { decimalAmountSchema } from '@mgx/validation';
import { z } from 'zod';

import { CurrentUser, Public, RequirePermissions } from '../../src/common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../src/common/auth/authenticated-user.js';
import { RateLimit } from '../../src/infrastructure/rate-limit/rate-limit.decorators.js';
import { RequiresFeature } from '../../src/modules/system-settings/presentation/access.decorators.js';

const transferSchema = z.strictObject({
  amount: decimalAmountSchema,
  note: z.string().max(20).optional(),
});
type Transfer = z.infer<typeof transferSchema>;

/**
 * Routes de test uniquement : elles exercent les mécanismes transverses (validation,
 * erreurs, fonctionnalités, maintenance, limitation de débit) sans logique métier.
 */
@Public()
@Controller({ path: 'probe', version: '1' })
class ProbeController {
  @Get('ping')
  ping(): { pong: true } {
    return { pong: true };
  }

  @Post('validate')
  validate(@Body({ schema: transferSchema }) body: Transfer): Transfer {
    return body;
  }

  @Get('crash')
  crash(): never {
    throw new Error('internal detail: connection string postgresql://user:pw@10.0.0.5/db');
  }

  @Get('exchange')
  @RequiresFeature('exchange')
  exchange(): { ok: true } {
    return { ok: true };
  }

  @Get('strict')
  @RateLimit({ name: 'probe-strict', limit: 2, windowMs: 60_000 })
  strict(): { ok: true } {
    return { ok: true };
  }
}

/** Routes de test non publiques : elles exercent l'authentification et les permissions. */
@Controller({ path: 'probe-private', version: '1' })
class PrivateProbeController {
  /** Aucune annotation : la route doit exiger une authentification, par défaut. */
  @Get('whoami')
  whoAmI(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  @Get('settings-writer')
  @RequirePermissions('system_settings.write')
  settingsWriter(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController, PrivateProbeController] })
export class ProbeModule {}
