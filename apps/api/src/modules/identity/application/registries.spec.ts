import { describe, expect, it } from '@jest/globals';

import { type AccountDataHolder, AccountDataRegistry } from './account-data.registry.js';
import {
  type MaintenanceStep,
  MaintenanceStepIncompleteError,
  MaintenanceStepRegistry,
} from './maintenance-step.registry.js';

const holder = (name: string): AccountDataHolder => ({
  name,
  closureBlockers: () => Promise.resolve([]),
  lockForClosure: () => Promise.resolve(),
  legalRetentionUntil: () => Promise.resolve(null),
  closeAccount: () => Promise.resolve(null),
  eraseRetained: () => Promise.resolve(),
  exportData: () => Promise.resolve({}),
});

const step = (name: string): MaintenanceStep => ({ name, run: () => Promise.resolve(0) });

describe('registres alimentés au démarrage', () => {
  it('les modules détenteurs de données sont appelés dans l’ordre de leur inscription, une fois chacun', () => {
    const registry = new AccountDataRegistry();
    expect(registry.holders()).toEqual([]);
    const kyc = holder('kyc');
    const wallets = holder('wallets');
    registry.register(kyc);
    registry.register(wallets);

    expect(registry.holders()).toEqual([kyc, wallets]);
    // Inscrit deux fois, un module effacerait — ou compterait — deux fois : erreur de câblage.
    expect(() => {
      registry.register(holder('kyc'));
    }).toThrow('Account data holder "kyc" is already registered.');
    expect(registry.holders()).toHaveLength(2);
  });

  it('les étapes de purge aussi', () => {
    const registry = new MaintenanceStepRegistry();
    const first = step('erase-closed-accounts');
    const second = step('purge-published-events');
    registry.register(first);
    registry.register(second);

    expect(registry.steps()).toEqual([first, second]);
    expect(() => {
      registry.register(step('erase-closed-accounts'));
    }).toThrow('Maintenance step "erase-closed-accounts" is already registered.');
    expect(registry.steps()).toHaveLength(2);
  });

  it('une étape incomplète dit ce qu’elle a traité et ce qui lui a résisté', () => {
    const error = new MaintenanceStepIncompleteError(3, 2, 'closed account(s)');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MaintenanceStepIncompleteError');
    expect({ done: error.done, failed: error.failed }).toEqual({ done: 3, failed: 2 });
    expect(error.message).toBe('2 closed account(s) could not be processed (3 processed).');
  });
});
