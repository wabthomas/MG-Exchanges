import { describe, expect, it } from '@jest/globals';
import { defineAsset, Money } from '@mgx/shared';

import {
  assertValidJournalEntry,
  IDEMPOTENCY_KEY_PATTERN,
  type JournalEntryDraft,
  LEDGER_AMOUNT_MAX_UNITS,
  LEDGER_ENTRY_MAX_POSTINGS,
  LEDGER_ENTRY_METADATA_MAX_BYTES,
  type PostingDraft,
} from './journal-entry.js';
import { type AccountRef, platformAccount, userAccount } from './ledger-account.js';
import { type LedgerRuleCode, LedgerRuleError } from './ledger-errors.js';

const USD = defineAsset('USD', 2);
const CDF = defineAsset('CDF', 2);
const ALICE = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const BOB = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1e';

const usd = (amount: string): Money => Money.parse(amount, USD);
const debit = (account: AccountRef, amount: Money): PostingDraft => ({
  account,
  side: 'DEBIT',
  amount,
});
const credit = (account: AccountRef, amount: Money): PostingDraft => ({
  account,
  side: 'CREDIT',
  amount,
});

function draft(overrides: Partial<JournalEntryDraft> = {}): JournalEntryDraft {
  return {
    idempotencyKey: 'transfer:0195f3a2',
    kind: 'transfer.internal',
    actor: { type: 'USER', id: ALICE },
    postings: [debit(userAccount(ALICE), usd('10.00')), credit(userAccount(BOB), usd('10.00'))],
    ...overrides,
  };
}

/** Code de la règle qui refuse l'écriture, ou `null` si elle est recevable. */
function refusal(overrides: Partial<JournalEntryDraft>): LedgerRuleCode | null {
  try {
    assertValidJournalEntry(draft(overrides));
    return null;
  } catch (error) {
    if (error instanceof LedgerRuleError) {
      return error.code;
    }
    throw error;
  }
}

describe('assertValidJournalEntry', () => {
  it('accepte un transfert équilibré, avec ou sans références', () => {
    expect(refusal({})).toBeNull();
    expect(refusal({ requestId: 'req-12345678', metadata: {} })).toBeNull();
    expect(refusal({ actor: { type: 'SYSTEM' } })).toBeNull();
    expect(refusal({ actor: { type: 'SERVICE', id: 'bank-x' } })).toBeNull();
  });

  it('une clé d’idempotence de 8 à 160 caractères sûrs, qui commence par une lettre ou un chiffre', () => {
    for (const idempotencyKey of [
      '',
      'a'.repeat(7),
      'a'.repeat(161),
      '-transfer:1',
      ':transfer:1',
      '.transfer:1',
      '_transfer:1',
      'transfer 12345',
      'transfer/12345',
      'transfer:é2345',
      'transfer:1234\n',
    ]) {
      expect({ idempotencyKey, code: refusal({ idempotencyKey }) }).toEqual({
        idempotencyKey,
        code: 'INVALID_IDEMPOTENCY_KEY',
      });
    }
    for (const idempotencyKey of [
      'a'.repeat(8),
      'a'.repeat(160),
      '1transfer',
      `Transfer:${ALICE}`,
      'deposit.bank_x:2026-11-13:0001',
    ]) {
      expect({ idempotencyKey, code: refusal({ idempotencyKey }) }).toEqual({
        idempotencyKey,
        code: null,
      });
    }
    // Le même format que celui que la base impose.
    expect(IDEMPOTENCY_KEY_PATTERN.source).toBe('^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$');
  });

  it('un type en minuscules, en segments séparés par des points, de 64 caractères au plus', () => {
    for (const kind of [
      '',
      'Transfer',
      'transfer.',
      '.transfer',
      'transfer..internal',
      'transfer-internal',
      'transfer internal',
      'transfer.1internal',
      'transfer.internal\n',
      'a'.repeat(65),
    ]) {
      expect({ kind, code: refusal({ kind }) }).toEqual({ kind, code: 'INVALID_KIND' });
    }
    for (const kind of ['deposit', 'transfer.internal', 'a1.b_2.c', 'a'.repeat(64)]) {
      expect({ kind, code: refusal({ kind }) }).toEqual({ kind, code: null });
    }
  });

  it('un auteur identifié — sauf la plateforme elle-même', () => {
    expect(refusal({ actor: { type: 'USER', id: '' } })).toBe('INVALID_ACTOR');
    expect(refusal({ actor: { type: 'SERVICE', id: '' } })).toBe('INVALID_ACTOR');
    expect(refusal({ actor: { type: 'SERVICE', id: 'x'.repeat(65) } })).toBe('INVALID_ACTOR');
    expect(refusal({ actor: { type: 'SERVICE', id: 'x'.repeat(64) } })).toBeNull();
    expect(refusal({ actor: { type: 'USER', id: 'x' } })).toBeNull();
  });

  it('un identifiant de requête de 128 caractères au plus', () => {
    expect(refusal({ requestId: 'r'.repeat(128) })).toBeNull();
    expect(refusal({ requestId: 'r'.repeat(129) })).toBe('INVALID_REQUEST_ID');
  });

  it('des références simples : identifiants, codes, entiers, booléens — ni texte libre, ni structure', () => {
    expect(
      refusal({
        metadata: {
          transferId: ALICE,
          attempt: 3,
          negative: -1,
          confirmed: false,
          note: null,
          empty: '',
          a: '~ !"#$%&()*+,-./:;<=>?@[]^_`{|}',
          [`k${'x'.repeat(63)}`]: 'x'.repeat(255),
        },
      }),
    ).toBeNull();

    const invalid: Record<string, unknown>[] = [
      { nested: { a: 1 } },
      { list: [1, 2] },
      { ratio: 0.5 },
      { huge: Number.MAX_SAFE_INTEGER + 1 },
      { nan: Number.NaN },
      { infinite: Number.POSITIVE_INFINITY },
      { amount: 10n },
      { missing: undefined },
      { name: 'Élise' },
      { text: 'two\nlines' },
      { text: 'tab\there' },
      { text: 'nul\u0000' },
      { text: 'del\u007F' },
      { text: 'x'.repeat(256) },
      { '': 'empty name' },
      { '1st': 'starts with a digit' },
      { 'with-dash': 'x' },
      { 'with space': 'x' },
      { [`k${'x'.repeat(64)}`]: 'name too long' },
      { clé: 'x' },
    ];
    for (const metadata of invalid) {
      expect({
        metadata: Object.keys(metadata),
        code: refusal({ metadata: metadata as JournalEntryDraft['metadata'] }),
      }).toEqual({ metadata: Object.keys(metadata), code: 'INVALID_METADATA' });
    }
  });

  it('des références de 2048 octets au plus, une fois écrites en JSON', () => {
    // {"a":"…","b":"…", … } : huit valeurs de 255 caractères, puis une dernière sur mesure.
    const filled = (lastLength: number): Record<string, string> => {
      const metadata: Record<string, string> = {};
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        metadata[name] = 'x'.repeat(255);
      }
      metadata['z'] = 'x'.repeat(lastLength);
      return metadata;
    };
    const length = (metadata: Record<string, string>): number => JSON.stringify(metadata).length;
    const fitting = filled(0);
    const room = LEDGER_ENTRY_METADATA_MAX_BYTES - length(fitting);
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThanOrEqual(255);
    expect(length(filled(room))).toBe(2048);

    expect(refusal({ metadata: filled(room) })).toBeNull();
    expect(refusal({ metadata: filled(room + 1) })).toBe('METADATA_TOO_LARGE');
  });

  it('de 2 à 100 lignes', () => {
    const pair = draft().postings;
    expect(refusal({ postings: [] })).toBe('TOO_FEW_POSTINGS');
    expect(refusal({ postings: [pair[0]!] })).toBe('TOO_FEW_POSTINGS');
    const lines = (count: number): PostingDraft[] =>
      Array.from({ length: count / 2 }, () => pair).flat();
    expect(LEDGER_ENTRY_MAX_POSTINGS).toBe(100);
    expect(refusal({ postings: lines(100) })).toBeNull();
    expect(refusal({ postings: lines(102) })).toBe('TOO_MANY_POSTINGS');
  });

  it('chaque ligne désigne un compte cohérent : le type appartient à qui la référence le dit', () => {
    const amount = usd('1.00');
    const invalid: AccountRef[] = [
      { owner: 'USER', type: 'platform_fees', userId: ALICE } as unknown as AccountRef,
      { owner: 'PLATFORM', type: 'user_available' } as unknown as AccountRef,
      { owner: 'USER', type: 'user_savings', userId: ALICE } as unknown as AccountRef,
      { owner: 'USER', type: 'toString', userId: ALICE } as unknown as AccountRef,
      userAccount('not-a-uuid'),
      userAccount(''),
      userAccount(ALICE.toUpperCase()),
      userAccount(`${ALICE}\n`),
    ];
    for (const account of invalid) {
      expect({
        account,
        code: refusal({ postings: [debit(account, amount), credit(userAccount(BOB), amount)] }),
      }).toEqual({ account, code: 'INVALID_ACCOUNT' });
    }
    for (const account of [
      userAccount(ALICE),
      platformAccount('platform_custody'),
      platformAccount('platform_fees'),
    ]) {
      expect(
        refusal({ postings: [debit(account, amount), credit(userAccount(BOB), amount)] }),
      ).toBeNull();
    }
  });

  it('un montant strictement positif : c’est le sens de la ligne qui dit où vont les fonds', () => {
    const lines = (amount: Money): PostingDraft[] => [
      debit(userAccount(ALICE), amount),
      credit(userAccount(BOB), amount),
    ];
    expect(refusal({ postings: lines(usd('0.00')) })).toBe('NON_POSITIVE_AMOUNT');
    expect(refusal({ postings: lines(usd('-0.01')) })).toBe('NON_POSITIVE_AMOUNT');
    expect(refusal({ postings: lines(usd('0.01')) })).toBeNull();
  });

  it('un montant de 38 chiffres au plus, en unités minimales', () => {
    const lines = (units: bigint): PostingDraft[] => [
      debit(userAccount(ALICE), Money.ofUnits(units, USD)),
      credit(userAccount(BOB), Money.ofUnits(units, USD)),
    ];
    expect(LEDGER_AMOUNT_MAX_UNITS).toBe(99_999_999_999_999_999_999_999_999_999_999_999_999n);
    expect(refusal({ postings: lines(LEDGER_AMOUNT_MAX_UNITS) })).toBeNull();
    expect(refusal({ postings: lines(LEDGER_AMOUNT_MAX_UNITS + 1n) })).toBe('AMOUNT_TOO_LARGE');
  });

  it('un actif s’écrit partout avec le même nombre de décimales', () => {
    const cents = Money.ofUnits(1000n, USD);
    const mills = Money.ofUnits(1000n, defineAsset('USD', 3));
    expect(
      refusal({ postings: [debit(userAccount(ALICE), cents), credit(userAccount(BOB), mills)] }),
    ).toBe('ASSET_MISMATCH');
  });

  it('entre deux comptes au moins', () => {
    const amount = usd('5.00');
    expect(
      refusal({
        postings: [debit(userAccount(ALICE), amount), credit(userAccount(ALICE), amount)],
      }),
    ).toBe('SINGLE_ACCOUNT');
    // Le même titulaire dans deux actifs : deux comptes — mais alors rien ne s'équilibre.
    expect(
      refusal({
        postings: [
          debit(userAccount(ALICE), amount),
          credit(userAccount(ALICE), Money.parse('5.00', CDF)),
        ],
      }),
    ).toBe('UNBALANCED');
    // Un compte de la plateforme et celui d'un titulaire : deux comptes.
    expect(
      refusal({
        postings: [
          debit(platformAccount('platform_custody'), amount),
          credit(userAccount(ALICE), amount),
        ],
      }),
    ).toBeNull();
    expect(
      refusal({
        postings: [
          debit(platformAccount('platform_custody'), amount),
          credit(platformAccount('platform_custody'), amount),
        ],
      }),
    ).toBe('SINGLE_ACCOUNT');
  });

  it('des débits égaux aux crédits', () => {
    const alice = userAccount(ALICE);
    const bob = userAccount(BOB);
    expect(refusal({ postings: [debit(alice, usd('10.00')), credit(bob, usd('9.99'))] })).toBe(
      'UNBALANCED',
    );
    expect(refusal({ postings: [debit(alice, usd('9.99')), credit(bob, usd('10.00'))] })).toBe(
      'UNBALANCED',
    );
    expect(refusal({ postings: [debit(alice, usd('10.00')), debit(bob, usd('10.00'))] })).toBe(
      'UNBALANCED',
    );
    expect(refusal({ postings: [credit(alice, usd('10.00')), credit(bob, usd('10.00'))] })).toBe(
      'UNBALANCED',
    );
    // Un débit réparti sur deux crédits.
    expect(
      refusal({
        postings: [
          debit(alice, usd('10.00')),
          credit(bob, usd('9.70')),
          credit(platformAccount('platform_fees'), usd('0.30')),
        ],
      }),
    ).toBeNull();
  });

  it('actif par actif : cent dollars ne compensent pas cent francs', () => {
    const alice = userAccount(ALICE);
    const custody = platformAccount('platform_custody');
    const cdf = (amount: string): Money => Money.parse(amount, CDF);
    expect(
      refusal({ postings: [debit(custody, usd('100.00')), credit(alice, cdf('100.00'))] }),
    ).toBe('UNBALANCED');
    // Équilibrée au total, dans aucun des deux actifs.
    expect(
      refusal({
        postings: [
          debit(custody, usd('100.00')),
          credit(alice, usd('60.00')),
          debit(custody, cdf('60.00')),
          credit(alice, cdf('100.00')),
        ],
      }),
    ).toBe('UNBALANCED');
    expect(
      refusal({
        postings: [
          debit(custody, usd('100.00')),
          credit(alice, usd('100.00')),
          debit(custody, cdf('2850.00')),
          credit(alice, cdf('2850.00')),
        ],
      }),
    ).toBeNull();
  });

  it('le message d’un refus ne contient aucun montant', () => {
    try {
      assertValidJournalEntry(
        draft({
          postings: [
            debit(userAccount(ALICE), usd('1234.56')),
            credit(userAccount(BOB), usd('1234.55')),
          ],
        }),
      );
      throw new Error('Expected a refusal.');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerRuleError);
      expect((error as Error).message).toBe(
        'The entry is not balanced in USD: its debits and credits differ.',
      );
      expect((error as Error).name).toBe('LedgerRuleError');
    }
  });
});
