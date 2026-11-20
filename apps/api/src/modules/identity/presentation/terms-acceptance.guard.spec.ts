import { describe, expect, it } from '@jest/globals';
import { Controller, type ExecutionContext, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import {
  AllowBeforeTermsAcceptance,
  Public,
  RequirePermissions,
} from '../../../common/auth/auth.decorators.js';
import { setAuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { TermsService } from '../application/terms.service.js';
import { TermsAcceptanceGuard } from './terms-acceptance.guard.js';

const USER_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

@Controller()
class OrdinaryController {
  @Get()
  ordinary(): string {
    return 'ok';
  }

  @Get()
  @AllowBeforeTermsAcceptance()
  allowed(): string {
    return 'ok';
  }

  @Get()
  @RequirePermissions('users.read')
  backOffice(): string {
    return 'ok';
  }

  @Get()
  @Public()
  open(): string {
    return 'ok';
  }
}

@Controller()
@AllowBeforeTermsAcceptance()
class AllowedController {
  @Get()
  inherited(): string {
    return 'ok';
  }
}

@Controller()
@RequirePermissions('terms.publish')
class BackOfficeController {
  @Get()
  inherited(): string {
    return 'ok';
  }

  /** Laisser ouverte une route du back-office ne change rien : elle n'était pas fermée. */
  @Get()
  @AllowBeforeTermsAcceptance()
  both(): string {
    return 'ok';
  }
}

type Handler = (...args: never[]) => unknown;

function contextOf(
  controller: new () => object,
  handler: Handler,
  options: { authenticated?: boolean; type?: string } = {},
): ExecutionContext {
  const request = {} as Request;
  if (options.authenticated !== false) {
    setAuthenticatedUser(request, { userId: USER_ID, sessionId: USER_ID });
  }
  return {
    getType: () => options.type ?? 'http',
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** Garde dont le service répond `required`, et compte ses lectures. */
function guardWith(required: boolean): { guard: TermsAcceptanceGuard; asked: string[] } {
  const asked: string[] = [];
  const terms = {
    isAcceptanceRequired: (userId: string): Promise<boolean> => {
      asked.push(userId);
      return Promise.resolve(required);
    },
  } as unknown as TermsService;
  return { guard: new TermsAcceptanceGuard(new Reflector(), terms), asked };
}

const ordinary = OrdinaryController.prototype;

describe('TermsAcceptanceGuard', () => {
  it('une route ordinaire est fermée au compte qui doit accepter : 403 TERMS_ACCEPTANCE_REQUIRED', async () => {
    const { guard, asked } = guardWith(true);
    const refusal = guard.canActivate(contextOf(OrdinaryController, ordinary.ordinary));
    await expect(refusal).rejects.toBeInstanceOf(AppError);
    await expect(refusal).rejects.toMatchObject({
      code: 'TERMS_ACCEPTANCE_REQUIRED',
      message: 'The current version of the terms of use must be accepted before continuing.',
    });
    expect(asked).toEqual([USER_ID]);
  });

  it('et ouverte à celui qui n’a rien à accepter', async () => {
    const { guard, asked } = guardWith(false);
    expect(await guard.canActivate(contextOf(OrdinaryController, ordinary.ordinary))).toBe(true);
    expect(asked).toEqual([USER_ID]);
  });

  it.each([
    ['route marquée @AllowBeforeTermsAcceptance', OrdinaryController, ordinary.allowed],
    [
      'contrôleur marqué @AllowBeforeTermsAcceptance',
      AllowedController,
      AllowedController.prototype.inherited,
    ],
    ['route du back-office', OrdinaryController, ordinary.backOffice],
    ['contrôleur du back-office', BackOfficeController, BackOfficeController.prototype.inherited],
    [
      'route du back-office marquée ouverte',
      BackOfficeController,
      BackOfficeController.prototype.both,
    ],
  ] as const)(
    '%s : laissée passer sans même consulter la base',
    async (_label, controller, handler) => {
      const { guard, asked } = guardWith(true);
      expect(await guard.canActivate(contextOf(controller, handler))).toBe(true);
      expect(asked).toEqual([]);
    },
  );

  it('personne n’est identifié sur une route publique : rien à exiger', async () => {
    const { guard, asked } = guardWith(true);
    expect(
      await guard.canActivate(
        contextOf(OrdinaryController, ordinary.open, { authenticated: false }),
      ),
    ).toBe(true);
    expect(asked).toEqual([]);
  });

  it('refus par défaut : sans marque, même une route « publique » appelée par un compte identifié est fermée', async () => {
    // La marque @Public ne vaut pas exemption : seule @AllowBeforeTermsAcceptance la donne.
    const { guard } = guardWith(true);
    await expect(
      guard.canActivate(contextOf(OrdinaryController, ordinary.open)),
    ).rejects.toMatchObject({ code: 'TERMS_ACCEPTANCE_REQUIRED' });
  });

  it('hors HTTP (tâches planifiées, files), la garde ne s’applique pas', async () => {
    const { guard, asked } = guardWith(true);
    expect(
      await guard.canActivate(contextOf(OrdinaryController, ordinary.ordinary, { type: 'rpc' })),
    ).toBe(true);
    expect(asked).toEqual([]);
  });
});
