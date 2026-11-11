import { describe, expect, it } from '@jest/globals';

import { isSensitiveKey, REDACTED, redactSensitive } from './redaction.js';

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'newPassword',
    'current_password',
    'passphrase',
    'accessToken',
    'refresh_token',
    'idToken',
    'Authorization',
    'cookie',
    'set-cookie',
    'apiKey',
    'x-api-key',
    'clientSecret',
    'privateKey',
    'private_key',
    'mnemonic',
    'seed',
    'seedPhrase',
    'otp',
    'otpCode',
    'pin',
    'cardPin',
    'cvv',
    'cardNumber',
    'pan',
    'webhookSignature',
    'sessionId',
    'credentials',
  ])('considère %j comme sensible', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'amount',
    'shipping',
    'mapping',
    'pinned',
    'spinner',
    'company',
    'expansion',
    'option',
    'userId',
    'email',
    'status',
    'keyboard',
    'publicKey',
    'requestId',
  ])('ne considère pas %j comme sensible', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('redactSensitive', () => {
  it('expurge en profondeur sans modifier l’objet d’origine', () => {
    const input = {
      user: { email: 'a@b.c', password: 'hunter2', profile: { pin: '1234', city: 'Kinshasa' } },
      attempts: [{ otp: '000000', channel: 'sms' }],
      amount: '12.50',
    };
    const output = redactSensitive(input);

    expect(output).toEqual({
      user: { email: 'a@b.c', password: REDACTED, profile: { pin: REDACTED, city: 'Kinshasa' } },
      attempts: [{ otp: REDACTED, channel: 'sms' }],
      amount: '12.50',
    });
    expect(input.user.password).toBe('hunter2');
    expect(JSON.stringify(output)).not.toMatch(/hunter2|1234|000000/);
  });

  it('expurge les jetons reconnaissables à leur valeur, quel que soit le nom de la clé', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    expect(redactSensitive({ note: `Bearer ${jwt}`, value: jwt, list: [jwt, 'plain'] })).toEqual({
      note: REDACTED,
      value: REDACTED,
      list: [REDACTED, 'plain'],
    });
    expect(redactSensitive('Bearer abc')).toBe(REDACTED);
  });

  it('expurge entièrement la valeur d’une clé sensible, même s’il s’agit d’un objet', () => {
    expect(redactSensitive({ credentials: { user: 'x', pass: 'y' } })).toEqual({
      credentials: REDACTED,
    });
  });

  it('laisse intactes les instances non parcourues (erreurs, dates) et les valeurs simples', () => {
    const error = new Error('boom');
    const date = new Date(0);
    const output = redactSensitive({ err: error, at: date, count: 3, ok: true, nothing: null });
    expect(output.err).toBe(error);
    expect(output.at).toBe(date);
    expect(output).toMatchObject({ count: 3, ok: true, nothing: null });
  });

  it('convertit les bigint en chaînes, et borne les cycles comme la profondeur', () => {
    expect(redactSensitive({ units: 123n })).toEqual({ units: '123' });

    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(redactSensitive(cyclic)).toEqual({ name: 'loop', self: '[CIRCULAR]' });

    let deep: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 12; level += 1) {
      deep = { child: deep };
    }
    expect(JSON.stringify(redactSensitive(deep))).toContain('[TRUNCATED]');
  });
});
