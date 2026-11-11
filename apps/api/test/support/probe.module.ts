import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { decimalAmountSchema } from '@mgx/validation';
import { z } from 'zod';

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

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
