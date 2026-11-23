import { describe, expect, it } from '@jest/globals';

import { type LedgerCheck, LedgerCheckRegistry } from './ledger-check.registry.js';
import {
  LedgerVerificationError,
  LedgerVerificationIncompleteError,
} from './ledger-verification.js';

const check = (name: string): LedgerCheck => ({ name, findAnomalies: () => Promise.resolve([]) });

describe('contrôles apportés à la vérification du grand livre', () => {
  it('les contrôles sont rendus dans l’ordre de leur inscription, une fois chacun', () => {
    const registry = new LedgerCheckRegistry();
    expect(registry.checks()).toEqual([]);
    const transfers = check('transfers');
    const adjustments = check('adjustments');
    registry.register(transfers);
    registry.register(adjustments);

    expect(registry.checks()).toEqual([transfers, adjustments]);
    // Inscrit deux fois, un contrôle relèverait deux fois chaque anomalie : erreur de câblage.
    expect(() => {
      registry.register(check('transfers'));
    }).toThrow('Ledger check "transfers" is already registered.');
    expect(registry.checks()).toHaveLength(2);
  });

  it('une vérification qui échoue dit ce qu’elle a relevé, et ce qu’elle n’a pas pu relire', () => {
    const anomalies = [{ kind: 'ENTRY_UNSOUND', subject: 'entry-1' }];

    const complete = new LedgerVerificationError(anomalies);
    expect(complete).toBeInstanceOf(Error);
    expect(complete.name).toBe('LedgerVerificationError');
    expect(complete.anomalies).toBe(anomalies);
    expect(complete.failedChecks).toEqual([]);
    expect(complete.message).toBe('The ledger failed its verification: 1 anomaly(ies) found.');

    const partial = new LedgerVerificationError(anomalies, ['transfers', 'adjustments']);
    expect(partial.failedChecks).toEqual(['transfers', 'adjustments']);
    expect(partial.message).toBe(
      'The ledger failed its verification: 1 anomaly(ies) found. ' +
        '2 check(s) failed (transfers, adjustments).',
    );

    const unverified = new LedgerVerificationIncompleteError(['ledger']);
    expect(unverified).toBeInstanceOf(Error);
    expect(unverified.name).toBe('LedgerVerificationIncompleteError');
    expect(unverified.failedChecks).toEqual(['ledger']);
    expect(unverified.message).toBe(
      'The ledger could not be verified entirely: 1 check(s) failed (ledger).',
    );
  });
});
