import { describe, expect, it } from '@jest/globals';
import { CLOSED_ACCOUNT_IDENTIFIERS_RETENTION_DAYS } from '@mgx/contracts';

import {
  addYearsUtc,
  CLOSED_ACCOUNT_EMAIL_DOMAIN,
  closedAccountEmail,
  erasureDueAt,
  isReservedEmail,
  latestRetention,
} from './account-closure.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const at = (iso: string): Date => new Date(iso);

describe('adresse factice d’un compte clôturé', () => {
  it('est dérivée de l’identifiant du compte, dans un domaine qui ne peut pas exister', () => {
    // La forme est aussi imposée par la base de données : elle est écrite ici en toutes lettres.
    expect(CLOSED_ACCOUNT_EMAIL_DOMAIN).toBe('closed.invalid');
    expect(closedAccountEmail('0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d')).toBe(
      'closed-0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d@closed.invalid',
    );
  });

  it('le domaine est réservé : toute adresse qui s’y trouve, quelle que soit sa casse', () => {
    for (const email of [
      'closed-0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d@closed.invalid',
      'someone@closed.invalid',
      'Someone@Closed.Invalid',
      'a@CLOSED.INVALID',
    ]) {
      expect({ email, reserved: isReservedEmail(email) }).toEqual({ email, reserved: true });
    }
    for (const email of [
      'jean@example.cd',
      'closed.invalid@example.cd',
      'jean@closed.invalid.example.cd',
      'jean@notclosed.invalid',
      'jean@sub.closed.invalid',
      'jean@closed.invalid.',
      'closed.invalid',
    ]) {
      expect({ email, reserved: isReservedEmail(email) }).toEqual({ email, reserved: false });
    }
  });
});

describe('échéance d’effacement', () => {
  const closedAt = at('2026-11-12T10:00:00.000Z');

  it('sans conservation légale : trente jours après la clôture', () => {
    expect(CLOSED_ACCOUNT_IDENTIFIERS_RETENTION_DAYS).toBe(30);
    expect(erasureDueAt(closedAt, null)).toEqual(at('2026-12-12T10:00:00.000Z'));
  });

  it('avec une conservation légale : à son terme, et jamais moins de trente jours après la clôture', () => {
    const term = at('2036-11-12T10:00:00.000Z');
    expect(erasureDueAt(closedAt, term)).toEqual(term);
    // Un terme plus proche que trente jours ne raccourcit pas le délai laissé au titulaire.
    const soon = new Date(closedAt.getTime() + 29 * DAY_MS);
    expect(erasureDueAt(closedAt, soon)).toEqual(at('2026-12-12T10:00:00.000Z'));
    const exactly = new Date(closedAt.getTime() + 30 * DAY_MS);
    expect(erasureDueAt(closedAt, exactly)).toEqual(exactly);
    expect(erasureDueAt(closedAt, new Date(exactly.getTime() + 1))).toEqual(
      new Date(exactly.getTime() + 1),
    );
  });
});

describe('années civiles (UTC)', () => {
  it('le même instant, n années plus tard', () => {
    expect(addYearsUtc(at('2026-11-12T10:20:30.456Z'), 10)).toEqual(at('2036-11-12T10:20:30.456Z'));
    expect(addYearsUtc(at('2026-01-01T00:00:00.000Z'), 1)).toEqual(at('2027-01-01T00:00:00.000Z'));
    expect(addYearsUtc(at('2026-12-31T23:59:59.999Z'), 10)).toEqual(at('2036-12-31T23:59:59.999Z'));
    expect(addYearsUtc(at('2026-11-12T10:00:00.000Z'), 0)).toEqual(at('2026-11-12T10:00:00.000Z'));
  });

  it('un 29 février donne le 1ᵉʳ mars d’une année non bissextile — jamais plus tôt que la base', () => {
    // PostgreSQL retient le 28 février : le terme calculé ici n'est jamais en deçà du sien.
    expect(addYearsUtc(at('2028-02-29T12:00:00.000Z'), 10)).toEqual(at('2038-03-01T12:00:00.000Z'));
    expect(addYearsUtc(at('2028-02-29T12:00:00.000Z'), 4)).toEqual(at('2032-02-29T12:00:00.000Z'));
  });

  it('ne dépend pas du fuseau du serveur : un changement d’heure ne décale rien', () => {
    // 28 mars 2027, 01:30 UTC : l'Europe passe à l'heure d'été cette nuit-là.
    expect(addYearsUtc(at('2027-03-28T01:30:00.000Z'), 10).toISOString()).toBe(
      '2037-03-28T01:30:00.000Z',
    );
  });
});

describe('terme le plus lointain', () => {
  it('retient le plus tardif des termes déclarés ; aucun si personne n’en déclare', () => {
    const early = at('2030-01-01T00:00:00.000Z');
    const late = at('2036-11-12T10:00:00.000Z');
    expect(latestRetention([])).toBeNull();
    expect(latestRetention([null, null])).toBeNull();
    expect(latestRetention([early])).toEqual(early);
    expect(latestRetention([null, early, null])).toEqual(early);
    expect(latestRetention([early, late])).toEqual(late);
    expect(latestRetention([late, null, early])).toEqual(late);
  });
});
