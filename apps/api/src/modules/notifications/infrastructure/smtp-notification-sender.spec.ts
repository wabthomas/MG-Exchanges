import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_SMTP_TIMEOUTS,
  describeSmtpFailure,
  isSingleAddress,
  SmtpDeliveryError,
  type SmtpSenderOptions,
  smtpTransportOptions,
} from './smtp-notification-sender.js';

const PASSWORD = 'smtp-acc0unt-p4ssword';
const options: SmtpSenderOptions = {
  host: 'smtp.mail-provider.example',
  port: 587,
  security: 'starttls',
  auth: { user: 'apikey', password: PASSWORD },
  from: { name: 'MG-Exchange', address: 'no-reply@mg-exchange.example' },
};

describe('smtpTransportOptions', () => {
  it('`starttls` exige le passage en TLS ; `tls` chiffre dès l’ouverture ; `none` n’exige rien', () => {
    expect(smtpTransportOptions(options)).toMatchObject({ secure: false, requireTLS: true });
    expect(smtpTransportOptions({ ...options, security: 'tls', port: 465 })).toMatchObject({
      secure: true,
      requireTLS: false,
    });
    expect(smtpTransportOptions({ ...options, security: 'none' })).toMatchObject({
      secure: false,
      requireTLS: false,
    });
  });

  it('ne désactive jamais la vérification du certificat et refuse les protocoles obsolètes', () => {
    for (const security of ['starttls', 'tls', 'none'] as const) {
      const { tls } = smtpTransportOptions({ ...options, security });
      expect(tls).toEqual({ minVersion: 'TLSv1.2' });
      expect(tls).not.toHaveProperty('rejectUnauthorized');
    }
  });

  it('borne chaque étape de la connexion et coupe le journal de la bibliothèque', () => {
    expect(smtpTransportOptions(options)).toMatchObject({
      host: 'smtp.mail-provider.example',
      port: 587,
      auth: { user: 'apikey', pass: PASSWORD },
      dnsTimeout: DEFAULT_SMTP_TIMEOUTS.dnsMs,
      connectionTimeout: DEFAULT_SMTP_TIMEOUTS.connectionMs,
      greetingTimeout: DEFAULT_SMTP_TIMEOUTS.greetingMs,
      socketTimeout: DEFAULT_SMTP_TIMEOUTS.socketMs,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
    });
    expect(DEFAULT_SMTP_TIMEOUTS).toEqual({
      dnsMs: 5000,
      connectionMs: 10_000,
      greetingMs: 10_000,
      socketMs: 30_000,
    });
  });

  it('sans identifiants, aucune authentification n’est tentée', () => {
    expect(smtpTransportOptions({ ...options, auth: null })).not.toHaveProperty('auth');
  });
});

describe('isSingleAddress', () => {
  it('accepte une adresse nue', () => {
    for (const address of [
      'aline.kabila@example.cd',
      'a+tag@sub.example.co',
      "o'brien@example.com",
      'été@exemple.fr',
    ]) {
      expect(isSingleAddress(address)).toBe(true);
    }
  });

  it('refuse tout ce qui pourrait désigner plusieurs destinataires ou un autre', () => {
    for (const hostile of [
      'a@example.cd, b@evil.test',
      'a@example.cd;b@evil.test',
      'a@example.cd b@evil.test',
      'a@example.cd\r\nBcc: b@evil.test',
      'a@example.cd\nb@evil.test',
      'Name <a@example.cd>',
      '"a@example.cd" <b@evil.test>',
      'b@evil.test (a@example.cd)',
      'a@example.cd@evil.test',
      'group: a@example.cd;',
      'a@[127.0.0.1]',
      'a@example.cd\u0000',
      ' a@example.cd',
      'a@example.cd ',
      'no-at-sign',
      '@example.cd',
      'a@',
      '',
    ]) {
      expect(isSingleAddress(hostile)).toBe(false);
    }
  });
});

describe('describeSmtpFailure', () => {
  const smtpError = (fields: Record<string, unknown>): Error =>
    Object.assign(new Error('raw library message'), fields);

  it('masque toute adresse citée par le serveur et borne la longueur de sa réponse', () => {
    const failure = describeSmtpFailure(
      smtpError({
        code: 'EENVELOPE',
        command: 'RCPT TO',
        responseCode: 550,
        permanent: true,
        response:
          '550 5.1.1 <aline.kabila@example.cd>: Recipient address rejected:\r\n User unknown (was aline.kabila@example.cd)',
      }),
    );

    expect(failure).toEqual({
      code: 'EENVELOPE',
      command: 'RCPT TO',
      responseCode: 550,
      serverReply:
        '550 5.1.1 <<address>>: Recipient address rejected: User unknown (was <address>)',
      recipientRefused: true,
    });
    expect(
      describeSmtpFailure(smtpError({ response: `554 ${'x'.repeat(1000)}` })).serverReply,
    ).toHaveLength(300);
  });

  it('ne tient pour un refus du destinataire qu’un refus définitif de la commande RCPT TO', () => {
    const refused = { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, permanent: true };
    expect(describeSmtpFailure(smtpError(refused)).recipientRefused).toBe(true);

    for (const other of [
      { ...refused, permanent: false, responseCode: 450 }, // refus temporaire : à retenter
      { ...refused, command: 'MAIL FROM' }, // expéditeur refusé : défaut de configuration
      { ...refused, code: 'EMESSAGE', command: 'DATA' }, // message refusé
      { code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535, permanent: true },
      { code: 'ETIMEDOUT' },
      {},
    ]) {
      expect(describeSmtpFailure(smtpError(other)).recipientRefused).toBe(false);
    }
  });

  it('une erreur sans forme connue reste décrite, sans rien inventer', () => {
    for (const unknown of [undefined, null, 'boom', 42, new Error('boom')]) {
      expect(describeSmtpFailure(unknown)).toEqual({
        code: 'UNKNOWN',
        command: null,
        responseCode: null,
        serverReply: null,
        recipientRefused: false,
      });
    }
  });

  it('l’erreur remontée ne reprend que ces éléments — pas le message de la bibliothèque', () => {
    const error = new SmtpDeliveryError(
      describeSmtpFailure(
        smtpError({
          code: 'EAUTH',
          command: 'AUTH PLAIN',
          responseCode: 535,
          response: '535 5.7.8 Authentication credentials invalid',
        }),
      ),
    );

    expect(error.message).toBe(
      'SMTP delivery failed (EAUTH during AUTH PLAIN): 535 5.7.8 Authentication credentials invalid',
    );
    expect(error).toMatchObject({ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 });
    expect(
      new SmtpDeliveryError(describeSmtpFailure(smtpError({ code: 'ETIMEDOUT' }))).message,
    ).toBe('SMTP delivery failed (ETIMEDOUT).');
  });
});
