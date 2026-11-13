import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';

import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import type { RenderedNotification } from '../../src/modules/notifications/domain/notification.js';
import {
  SmtpDeliveryError,
  type SmtpLogger,
  SmtpNotificationSender,
  type SmtpSenderOptions,
} from '../../src/modules/notifications/infrastructure/smtp-notification-sender.js';
import {
  createTestCertificate,
  startSmtpServer,
  type TestCertificate,
  type TestSmtpServer,
  type TestSmtpServerOptions,
} from '../support/smtp.js';

const ACCOUNT = { user: 'mgx-sender', password: 'smtp-test-password-7391' };
const RECIPIENT = 'aline.kabila@example.cd';
const CODE = '482913';

const message: RenderedNotification = {
  channel: 'EMAIL',
  recipient: RECIPIENT,
  template: 'email_verification_code',
  locale: 'fr',
  subject: 'Vérifiez votre adresse e-mail — MG-Exchange',
  text: `Bonjour,\n\nVotre code de vérification est ${CODE}. Il expire dans 15 minutes.\n\nSi vous n’êtes pas à l’origine de cette demande, ignorez ce message.\n\n— L’équipe MG-Exchange`,
};

interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

describe('Envoi des e-mails par SMTP — face à un vrai serveur SMTP', () => {
  let certificate: TestCertificate;
  let server: TestSmtpServer | undefined;
  let sender: SmtpNotificationSender | undefined;
  let logs: LogEntry[] = [];

  beforeAll(() => {
    certificate = createTestCertificate();
  });

  afterEach(async () => {
    sender?.onModuleDestroy();
    await server?.close();
    sender = undefined;
    server = undefined;
    logs = [];
  });

  const logger: SmtpLogger = {
    info: (fields, text) => logs.push({ level: 'info', fields, message: text }),
    warn: (fields, text) => logs.push({ level: 'warn', fields, message: text }),
    error: (fields, text) => logs.push({ level: 'error', fields, message: text }),
  };

  async function listen(options: TestSmtpServerOptions = {}): Promise<TestSmtpServer> {
    server = await startSmtpServer(options);
    return server;
  }

  function connect(
    target: { readonly host: string; readonly port: number },
    options: Partial<SmtpSenderOptions> = {},
  ): SmtpNotificationSender {
    sender = new SmtpNotificationSender(
      {
        host: target.host,
        port: target.port,
        security: 'none',
        auth: null,
        from: { name: 'MG-Exchange', address: 'no-reply@mg-exchange.test' },
        timeouts: { dnsMs: 1000, connectionMs: 1000, greetingMs: 500, socketMs: 2000 },
        ...options,
      },
      logger,
    );
    return sender;
  }

  /** Erreur levée par la remise, ou `undefined` si elle aboutit. */
  async function failureOf(action: Promise<void>): Promise<unknown> {
    try {
      await action;
      return undefined;
    } catch (error) {
      return error;
    }
  }

  const everythingLogged = (): string => JSON.stringify(logs);

  describe('remise', () => {
    it('le message arrive intact — expéditeur, destinataire, objet et texte accentués — et il est marqué comme automatique', async () => {
      const smtp = await listen();

      await connect(smtp).deliver(message);

      expect(smtp.messages).toHaveLength(1);
      const received = smtp.messages[0]!;
      expect(received.envelope).toEqual({ from: 'no-reply@mg-exchange.test', to: [RECIPIENT] });
      expect(received.mail.from?.value).toEqual([
        { name: 'MG-Exchange', address: 'no-reply@mg-exchange.test' },
      ]);
      expect(received.mail.to).toMatchObject({ value: [{ name: '', address: RECIPIENT }] });
      expect(received.mail.subject).toBe(message.subject);
      expect(received.mail.text?.trimEnd()).toBe(message.text);
      // Texte seul : ni HTML, ni pièce jointe.
      expect(received.mail.html).toBe(false);
      expect(received.mail.attachments).toEqual([]);
      expect(received.mail.headers.get('auto-submitted')).toBe('auto-generated');
      expect(received.mail.headers.get('x-auto-response-suppress')).toBe('All');
      expect(received.mail.headers.get('content-language')).toBe('fr');
      expect(received.mail.messageId).toMatch(/^<[^@\s]+@mg-exchange\.test>$/);
      expect(received.mail.date).toBeInstanceOf(Date);
    });

    it('sans nom affiché, l’expéditeur est l’adresse seule', async () => {
      const smtp = await listen();

      await connect(smtp, { from: { name: null, address: 'no-reply@mg-exchange.test' } }).deliver(
        message,
      );

      expect(smtp.messages[0]?.mail.from?.value).toEqual([
        { name: '', address: 'no-reply@mg-exchange.test' },
      ]);
    });

    it('le journal retient le modèle et l’identifiant du message — ni l’adresse, ni le code', async () => {
      const smtp = await listen();

      await connect(smtp).deliver(message);

      expect(logs).toEqual([
        {
          level: 'info',
          fields: {
            template: 'email_verification_code',
            messageId: smtp.messages[0]?.mail.messageId,
          },
          message: 'Email accepted by the SMTP server',
        },
      ]);
      expect(everythingLogged()).not.toContain(RECIPIENT);
      expect(everythingLogged()).not.toContain(CODE);
    });

    it('une adresse piégée est refusée avant tout échange : ni second destinataire, ni destinataire détourné', async () => {
      const smtp = await listen();
      const delivery = connect(smtp);

      // La bibliothèque SMTP lit un destinataire comme une liste et en extrait les adresses :
      // sans ce refus, chacune de ces formes ferait partir le message vers `attacker@evil.test`.
      for (const recipient of [
        `${RECIPIENT}, attacker@evil.test`,
        `${RECIPIENT}; attacker@evil.test`,
        `${RECIPIENT}\r\nBcc: attacker@evil.test`,
        `${RECIPIENT}>\r\nRCPT TO:<attacker@evil.test`,
        `"${RECIPIENT}" <attacker@evil.test>`,
        `attacker@evil.test (${RECIPIENT})`,
        ` ${RECIPIENT}`,
        '',
      ]) {
        const failure = await failureOf(delivery.deliver({ ...message, recipient }));
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
          'Refusing to send: the recipient is not a single email address (template "email_verification_code").',
        );
      }

      expect(smtp.recipientsSeen).toEqual([]);
      expect(smtp.messages).toEqual([]);
    });

    it('les SMS ne passent pas par SMTP', async () => {
      const smtp = await listen();
      const delivery = connect(smtp);

      expect(delivery.supports('EMAIL')).toBe(true);
      expect(delivery.supports('SMS')).toBe(false);
      await expect(
        delivery.deliver({ ...message, channel: 'SMS', recipient: '+243810000001' }),
      ).rejects.toThrow('No delivery is configured for SMS messages');
      expect(smtp.messages).toEqual([]);
    });
  });

  describe('chiffrement et authentification', () => {
    it('`starttls` : la connexion est chiffrée avant que les identifiants et le message ne partent', async () => {
      const smtp = await listen({
        encryption: 'starttls',
        certificate: certificate.server,
        account: ACCOUNT,
      });

      await connect(smtp, {
        host: 'localhost',
        security: 'starttls',
        auth: ACCOUNT,
        trustedCa: certificate.authority,
      }).deliver(message);

      expect(smtp.authentications).toEqual([
        { user: ACCOUNT.user, accepted: true, encrypted: true },
      ]);
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]).toMatchObject({ encrypted: true, authenticatedAs: ACCOUNT.user });
    });

    it('`starttls` : face à un serveur qui ne propose pas le chiffrement, rien ne part — pas même les identifiants', async () => {
      const smtp = await listen({ encryption: 'none', account: ACCOUNT });

      const failure = await failureOf(
        connect(smtp, { security: 'starttls', auth: ACCOUNT }).deliver(message),
      );

      expect(failure).toBeInstanceOf(SmtpDeliveryError);
      expect((failure as SmtpDeliveryError).code).toBe('ETLS');
      expect(smtp.authentications).toEqual([]);
      expect(smtp.recipientsSeen).toEqual([]);
      expect(smtp.messages).toEqual([]);
    });

    it('un certificat qu’aucune autorité reconnue n’atteste est refusé', async () => {
      const smtp = await listen({
        encryption: 'starttls',
        certificate: certificate.server,
        account: ACCOUNT,
      });

      // Même serveur, même configuration, mais sans déclarer l'autorité de test.
      const failure = await failureOf(
        connect(smtp, { host: 'localhost', security: 'starttls', auth: ACCOUNT }).deliver(message),
      );

      expect(failure).toBeInstanceOf(SmtpDeliveryError);
      expect(smtp.authentications).toEqual([]);
      expect(smtp.messages).toEqual([]);
    });

    it('un certificat émis pour un autre nom est refusé', async () => {
      const smtp = await listen({
        encryption: 'starttls',
        certificate: certificate.server,
        account: ACCOUNT,
      });

      // Le certificat vaut pour `localhost` et 127.0.0.1, pas pour ce nom.
      const failure = await failureOf(
        connect(smtp, {
          host: 'localhost.localdomain',
          security: 'starttls',
          auth: ACCOUNT,
          trustedCa: certificate.authority,
        }).deliver(message),
      );

      expect(failure).toBeInstanceOf(SmtpDeliveryError);
      expect(smtp.authentications).toEqual([]);
      expect(smtp.messages).toEqual([]);
    });

    it('`tls` : la connexion est chiffrée dès l’ouverture', async () => {
      const smtp = await listen({
        encryption: 'tls',
        certificate: certificate.server,
        account: ACCOUNT,
      });

      await connect(smtp, {
        host: 'localhost',
        security: 'tls',
        auth: ACCOUNT,
        trustedCa: certificate.authority,
      }).deliver(message);

      expect(smtp.authentications).toEqual([
        { user: ACCOUNT.user, accepted: true, encrypted: true },
      ]);
      expect(smtp.messages[0]).toMatchObject({ encrypted: true, authenticatedAs: ACCOUNT.user });
    });

    it('des identifiants refusés font échouer l’envoi, sans que l’erreur ne les contienne', async () => {
      const smtp = await listen({ account: ACCOUNT });
      const wrongPassword = 'not-the-smtp-password-5521';

      const failure = await failureOf(
        connect(smtp, { auth: { user: ACCOUNT.user, password: wrongPassword } }).deliver(message),
      );

      expect(failure).toBeInstanceOf(SmtpDeliveryError);
      expect(failure).toMatchObject({ code: 'EAUTH', responseCode: 535 });
      const described = `${(failure as Error).message} ${JSON.stringify(failure)}`;
      expect(described).not.toContain(wrongPassword);
      expect(described).not.toContain(RECIPIENT);
      expect(smtp.messages).toEqual([]);
    });
  });

  describe('refus et pannes', () => {
    it('destinataire refusé définitivement : pas de nouvel essai, un avertissement qui ne cite pas l’adresse', async () => {
      const smtp = await listen({
        recipientPolicy: (address) => ({
          code: 550,
          message: `5.1.1 <${address}>: Recipient address rejected: User unknown`,
        }),
      });

      // La remise se termine sans erreur : l'appelant ne réessaiera pas.
      await connect(smtp).deliver(message);

      expect(smtp.recipientsSeen).toEqual([RECIPIENT]);
      expect(smtp.messages).toEqual([]);
      expect(logs).toEqual([
        {
          level: 'warn',
          fields: {
            template: 'email_verification_code',
            responseCode: 550,
            serverReply: '550 5.1.1 <<address>>: Recipient address rejected: User unknown',
          },
          message: 'Email refused by the SMTP server for this recipient',
        },
      ]);
      expect(everythingLogged()).not.toContain(RECIPIENT);
    });

    it('refus temporaire du destinataire : l’échec est remonté pour être retenté, sans citer l’adresse', async () => {
      const smtp = await listen({
        recipientPolicy: (address) => ({
          code: 450,
          message: `4.2.0 <${address}>: Mailbox temporarily unavailable`,
        }),
      });

      const failure = await failureOf(connect(smtp).deliver(message));

      expect(failure).toBeInstanceOf(SmtpDeliveryError);
      expect(failure).toMatchObject({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 450 });
      expect((failure as Error).message).toBe(
        'SMTP delivery failed (EENVELOPE during RCPT TO): 450 4.2.0 <<address>>: Mailbox temporarily unavailable',
      );
      expect(logs).toEqual([]);
    });

    it('serveur injoignable : l’envoi échoue aussitôt', async () => {
      // Port fermé : celui d'un serveur que l'on vient d'arrêter.
      const stopped = await startSmtpServer();
      await stopped.close();

      const failure = await failureOf(connect(stopped).deliver(message));

      expect(failure).toBeInstanceOf(SmtpDeliveryError);
      expect(['ESOCKET', 'ECONNECTION']).toContain((failure as SmtpDeliveryError).code);
    });

    it('serveur qui accepte la connexion mais ne répond pas : l’envoi est abandonné dans le délai fixé', async () => {
      const sockets: Socket[] = [];
      const silent: Server = createServer((socket) => sockets.push(socket));
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
      const { port } = silent.address() as AddressInfo;

      try {
        const startedAt = Date.now();
        const failure = await failureOf(connect({ host: '127.0.0.1', port }).deliver(message));

        expect(failure).toBeInstanceOf(SmtpDeliveryError);
        expect((failure as SmtpDeliveryError).code).toBe('ETIMEDOUT');
        expect(Date.now() - startedAt).toBeLessThan(3000);
      } finally {
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve) => silent.close(() => resolve()));
      }
    });
  });

  describe('vérification au démarrage', () => {
    it('un serveur joignable et des identifiants acceptés sont signalés comme tels', async () => {
      const smtp = await listen({ account: ACCOUNT });

      expect(await connect(smtp, { auth: ACCOUNT }).verify()).toBe(true);

      expect(logs).toEqual([
        {
          level: 'info',
          fields: { host: smtp.host, port: smtp.port, security: 'none' },
          message: 'SMTP server is reachable and accepts the configured credentials',
        },
      ]);
      expect(smtp.messages).toEqual([]);
    });

    it('des identifiants refusés sont signalés en erreur, sans figurer au journal', async () => {
      const smtp = await listen({ account: ACCOUNT });
      const wrongPassword = 'not-the-smtp-password-5521';

      expect(
        await connect(smtp, { auth: { user: ACCOUNT.user, password: wrongPassword } }).verify(),
      ).toBe(false);

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        level: 'error',
        fields: { host: smtp.host, port: smtp.port, code: 'EAUTH', responseCode: 535 },
        message: 'SMTP server verification failed: emails cannot be sent',
      });
      expect(everythingLogged()).not.toContain(wrongPassword);
    });
  });
});
