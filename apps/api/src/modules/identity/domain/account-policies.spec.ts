import { describe, expect, it } from '@jest/globals';

import { describeUserAgent } from './device-description.js';
import { toSecondFactorProof } from './mfa-policy.js';
import { isVerifiablePhoneNumber, maskPhoneNumber } from './phone-policy.js';
import { checkBirthDate, formatCalendarDate, parseCalendarDate } from './profile-policy.js';

describe('date de naissance', () => {
  const today = new Date('2026-11-11T00:00:00.000Z');

  it('une personne est majeure le jour de ses dix-huit ans, pas la veille', () => {
    expect(checkBirthDate('2008-11-11', today)).toBeNull();
    expect(checkBirthDate('2008-11-12', today)).toBe('UNDER_MINIMUM_AGE');
    expect(checkBirthDate('1990-05-17', today)).toBeNull();
    expect(checkBirthDate('2026-11-11', today)).toBe('UNDER_MINIMUM_AGE');
    expect(checkBirthDate('2031-01-01', today)).toBe('UNDER_MINIMUM_AGE');
  });

  it('née un 29 février, elle est majeure le 1er mars d’une année non bissextile', () => {
    expect(checkBirthDate('2008-02-29', new Date('2026-02-28T00:00:00.000Z'))).toBe(
      'UNDER_MINIMUM_AGE',
    );
    expect(checkBirthDate('2008-02-29', new Date('2026-03-01T00:00:00.000Z'))).toBeNull();
  });

  it('refuse une date qui n’existe pas ou antérieure à 1900', () => {
    expect(checkBirthDate('1990-02-30', today)).toBe('NOT_A_DATE');
    expect(checkBirthDate('1990-13-01', today)).toBe('NOT_A_DATE');
    expect(checkBirthDate('not-a-date', today)).toBe('NOT_A_DATE');
    expect(checkBirthDate('1899-12-31', today)).toBe('TOO_OLD');
    expect(checkBirthDate('1900-01-01', today)).toBeNull();
  });

  it('une date civile se relit telle qu’elle a été écrite', () => {
    const date = parseCalendarDate('1990-05-17');
    expect(date?.toISOString()).toBe('1990-05-17T00:00:00.000Z');
    expect(formatCalendarDate(date ?? new Date(0))).toBe('1990-05-17');
    expect(parseCalendarDate('2023-02-29')).toBeNull();
  });
});

describe('numéros de téléphone vérifiables', () => {
  it.each(['+243812345678', '+243971234567', '+243900000000', '+243899999999'])(
    'accepte le mobile congolais %s',
    (phone) => {
      expect(isVerifiablePhoneNumber(phone)).toBe(true);
    },
  );

  it.each([
    ['fixe congolais', '+243121234567'],
    ['mobile congolais trop court', '+24381234567'],
    ['mobile congolais trop long', '+2438123456789'],
    ['numéro français', '+33612345678'],
    ['numéro surtaxé étranger', '+88212345678'],
    ['indicatif voisin (Congo-Brazzaville)', '+242061234567'],
  ])('refuse un %s', (_label, phone) => {
    expect(isVerifiablePhoneNumber(phone)).toBe(false);
  });

  it('le journal ne retient qu’un numéro masqué', () => {
    expect(maskPhoneNumber('+243812345678')).toBe('+243****5678');
    expect(maskPhoneNumber('+2431234')).toBe('****');
  });
});

describe('preuve du second facteur', () => {
  it('lit un code de l’application d’authentification ou un code de secours', () => {
    expect(toSecondFactorProof({ code: '123456' })).toEqual({ method: 'TOTP', code: '123456' });
    expect(toSecondFactorProof({ recoveryCode: 'ABCDE12345' })).toEqual({
      method: 'RECOVERY_CODE',
      code: 'ABCDE12345',
    });
  });

  it('n’accepte ni l’absence de preuve, ni deux preuves à la fois', () => {
    expect(toSecondFactorProof({})).toBeNull();
    expect(toSecondFactorProof({ code: '123456', recoveryCode: 'ABCDE12345' })).toBeNull();
  });
});

describe('description d’un appareil', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Chrome — Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      'Edge — Windows',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Safari — iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      'Chrome — Android',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', 'Firefox — Linux'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
      'Safari — macOS',
    ],
    ['okhttp/4.12.0 (Android 14)', 'Android'],
    ['MGExchange/1.0 CFNetwork/1496.0.7 Darwin/23.5.0', 'iOS'],
  ])('%s', (userAgent, description) => {
    expect(describeUserAgent(userAgent)).toBe(description);
  });

  it('ne recopie jamais un texte libre fourni par le client', () => {
    const hostile = 'Compte bloqué : rendez-vous sur https://evil.example pour le rétablir';
    expect(describeUserAgent(hostile)).toBeNull();
    expect(describeUserAgent(`${hostile} Android`)).toBe('Android');
    expect(describeUserAgent(undefined)).toBeNull();
    expect(describeUserAgent('')).toBeNull();
  });
});
