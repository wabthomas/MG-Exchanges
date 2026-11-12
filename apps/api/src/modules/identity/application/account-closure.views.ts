import type { AccountClosure, AdminAccountClosure } from '@mgx/contracts';

import type { ClosureRecord } from './account-closure.repository.js';

/** Ce que le titulaire apprend de la clôture de son compte. */
export function toClosureView(closure: ClosureRecord): AccountClosure {
  return {
    closedAt: closure.closedAt.toISOString(),
    legalRetentionUntil: closure.legalRetentionUntil?.toISOString() ?? null,
    erasureDueAt: closure.erasureDueAt.toISOString(),
  };
}

/** Ce que le back-office voit de la clôture d'un compte. */
export function toAdminClosureView(closure: ClosureRecord): AdminAccountClosure {
  return {
    ...toClosureView(closure),
    origin: closure.origin,
    closedBy: closure.closedBy,
    formerEmail: closure.email,
    formerPhone: closure.phone,
    erasedAt: closure.erasedAt?.toISOString() ?? null,
  };
}
