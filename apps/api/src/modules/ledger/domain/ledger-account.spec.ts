import { describe, expect, it } from '@jest/globals';
import { LEDGER_ACCOUNT_TYPES } from '@mgx/contracts';

import {
  type AccountKey,
  accountKeyOf,
  accountKeyText,
  type AccountRef,
  balanceAfterPosting,
  compareAccountKeys,
  isConsistentAccountRef,
  platformAccount,
  userAccount,
  WALLET_ACCOUNT_TYPE,
} from './ledger-account.js';
import {
  HolderClosedError,
  IdempotencyConflictError,
  InsufficientFundsError,
  LedgerIntegrityError,
  UnknownAssetError,
} from './ledger-errors.js';

const ALICE = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const BOB = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1e';

describe('références de compte', () => {
  it('le portefeuille d’un titulaire est son compte « fonds disponibles »', () => {
    expect(WALLET_ACCOUNT_TYPE).toBe('user_available');
    expect(userAccount(ALICE)).toEqual({ owner: 'USER', type: 'user_available', userId: ALICE });
    expect(platformAccount('platform_fees')).toEqual({ owner: 'PLATFORM', type: 'platform_fees' });
  });

  it('un compte est désigné par son type, son actif et son titulaire — aucun, pour la plateforme', () => {
    expect(accountKeyOf(userAccount(ALICE), 'USD')).toEqual({
      type: 'user_available',
      assetCode: 'USD',
      userId: ALICE,
    });
    expect(accountKeyOf(platformAccount('platform_custody'), 'CDF')).toEqual({
      type: 'platform_custody',
      assetCode: 'CDF',
      userId: null,
    });
  });

  it('deux clés ont le même texte si, et seulement si, elles désignent le même compte', () => {
    const keys: AccountKey[] = [
      accountKeyOf(userAccount(ALICE), 'USD'),
      accountKeyOf(userAccount(ALICE), 'CDF'),
      accountKeyOf(userAccount(BOB), 'USD'),
      accountKeyOf(platformAccount('platform_custody'), 'USD'),
      accountKeyOf(platformAccount('platform_fees'), 'USD'),
      accountKeyOf(platformAccount('platform_custody'), 'CDF'),
    ];
    expect(new Set(keys.map(accountKeyText)).size).toBe(keys.length);
    expect(accountKeyText(accountKeyOf(userAccount(ALICE), 'USD'))).toBe(
      accountKeyText({ type: 'user_available', assetCode: 'USD', userId: ALICE }),
    );
    expect(accountKeyText(accountKeyOf(platformAccount('platform_fees'), 'USD'))).toBe(
      'USD|platform_fees|',
    );
  });

  it('les clés ont un ordre unique, quel que soit celui dans lequel on les présente', () => {
    const keys: AccountKey[] = [
      accountKeyOf(userAccount(BOB), 'USD'),
      accountKeyOf(platformAccount('platform_fees'), 'USD'),
      accountKeyOf(userAccount(ALICE), 'USD'),
      accountKeyOf(userAccount(ALICE), 'CDF'),
      accountKeyOf(platformAccount('platform_custody'), 'USD'),
    ];
    const expected = [
      `CDF|user_available|${ALICE}`,
      'USD|platform_custody|',
      'USD|platform_fees|',
      `USD|user_available|${ALICE}`,
      `USD|user_available|${BOB}`,
    ];
    expect([...keys].sort(compareAccountKeys).map(accountKeyText)).toEqual(expected);
    expect([...keys].reverse().sort(compareAccountKeys).map(accountKeyText)).toEqual(expected);

    const [first, second] = keys as [AccountKey, AccountKey];
    expect(compareAccountKeys(first, first)).toBe(0);
    expect(compareAccountKeys(first, { ...first })).toBe(0);
    expect(compareAccountKeys(first, second)).toBe(1);
    expect(compareAccountKeys(second, first)).toBe(-1);
  });

  it('un type de compte appartient à un titulaire ou à la plateforme, jamais aux deux', () => {
    for (const [type, { owner }] of Object.entries(LEDGER_ACCOUNT_TYPES)) {
      const other = owner === 'USER' ? 'PLATFORM' : 'USER';
      expect(isConsistentAccountRef({ owner, type, userId: ALICE } as unknown as AccountRef)).toBe(
        true,
      );
      expect(
        isConsistentAccountRef({ owner: other, type, userId: ALICE } as unknown as AccountRef),
      ).toBe(false);
    }
    // Un type inconnu — ou une propriété héritée de tout objet — n'est pas un type de compte.
    for (const type of ['user_savings', 'constructor', 'toString', '__proto__', '']) {
      expect(
        isConsistentAccountRef({ owner: 'USER', type, userId: ALICE } as unknown as AccountRef),
      ).toBe(false);
    }
  });
});

describe('balanceAfterPosting', () => {
  it('le sens normal du compte augmente son solde ; l’autre le diminue', () => {
    // Fonds d'un titulaire : un crédit les augmente.
    expect(balanceAfterPosting(1000n, 'CREDIT', 'CREDIT', 250n)).toBe(1250n);
    expect(balanceAfterPosting(1000n, 'CREDIT', 'DEBIT', 250n)).toBe(750n);
    // Fonds conservés par la plateforme : un débit les augmente.
    expect(balanceAfterPosting(1000n, 'DEBIT', 'DEBIT', 250n)).toBe(1250n);
    expect(balanceAfterPosting(1000n, 'DEBIT', 'CREDIT', 250n)).toBe(750n);
  });

  it('ne refuse rien lui-même : un résultat négatif est rendu tel quel, à l’appelant d’en juger', () => {
    expect(balanceAfterPosting(100n, 'CREDIT', 'DEBIT', 101n)).toBe(-1n);
    expect(balanceAfterPosting(0n, 'DEBIT', 'CREDIT', 1n)).toBe(-1n);
    expect(balanceAfterPosting(100n, 'CREDIT', 'DEBIT', 100n)).toBe(0n);
  });

  it('reste exact au-delà de ce qu’un nombre flottant sait représenter', () => {
    const large = 10n ** 38n - 1n;
    expect(balanceAfterPosting(large - 1n, 'CREDIT', 'CREDIT', 1n)).toBe(large);
    expect(balanceAfterPosting(large, 'DEBIT', 'CREDIT', large)).toBe(0n);
  });
});

describe('erreurs du grand livre', () => {
  it('portent un nom, et un message sans montant ni identifiant de titulaire', () => {
    const funds = new InsufficientFundsError({
      type: 'user_available',
      assetCode: 'USD',
      userId: ALICE,
    });
    expect(funds.name).toBe('InsufficientFundsError');
    expect(funds.message).toBe('Insufficient funds on the user_available account in USD.');
    expect(funds.message).not.toContain(ALICE);

    const cause = new Error('MGX09');
    const refused = new InsufficientFundsError(null, { cause });
    expect(refused.account).toBeNull();
    expect(refused.message).toBe('Insufficient funds.');
    expect(refused.cause).toBe(cause);

    expect(new IdempotencyConflictError('transfer:1').message).toBe(
      'This idempotency key was already used for a different ledger entry.',
    );
    expect(new IdempotencyConflictError('transfer:1').idempotencyKey).toBe('transfer:1');
    expect(new UnknownAssetError('EUR').message).toBe('Asset EUR is not registered in the ledger.');
    expect(new HolderClosedError({ cause }).cause).toBe(cause);
    expect(new HolderClosedError().name).toBe('HolderClosedError');
    expect(new LedgerIntegrityError({ cause }).cause).toBe(cause);
    expect(new LedgerIntegrityError().name).toBe('LedgerIntegrityError');
  });
});
