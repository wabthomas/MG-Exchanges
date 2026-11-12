import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ParsedMail, simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';

import { eventually } from './test-app.js';

/** Message tel que le serveur SMTP de test l'a reçu. */
export interface ReceivedEmail {
  /** Enveloppe SMTP : ce que le serveur a réellement accepté, indépendamment des en-têtes. */
  readonly envelope: { readonly from: string; readonly to: readonly string[] };
  /** Message brut (en-têtes et corps encodés). */
  readonly raw: string;
  /** Message lu par un analyseur MIME : objet et texte décodés. */
  readonly mail: ParsedMail;
  /** Vrai si la connexion était chiffrée au moment de la remise. */
  readonly encrypted: boolean;
  /** Compte authentifié, le cas échéant. */
  readonly authenticatedAs: string | null;
}

/** Tentative d'authentification observée par le serveur. */
export interface AuthenticationAttempt {
  readonly user: string;
  readonly accepted: boolean;
  /** Vrai si la connexion était chiffrée lorsque les identifiants ont été présentés. */
  readonly encrypted: boolean;
}

export interface TestSmtpServerOptions {
  /**
   * Chiffrement proposé : `none` (aucun), `starttls` (annoncé, sur connexion en clair) ou
   * `tls` (dès l'ouverture). Les deux derniers exigent `certificate`.
   */
  readonly encryption?: 'none' | 'starttls' | 'tls';
  readonly certificate?: { readonly key: string; readonly cert: string };
  /** Compte attendu ; sans lui, le serveur accepte les connexions anonymes. */
  readonly account?: { readonly user: string; readonly password: string };
  /**
   * Réponse à faire pour un destinataire : `null` pour l'accepter, ou le code et le texte du
   * refus.
   */
  readonly recipientPolicy?: (address: string) => { code: number; message: string } | null;
}

export interface TestSmtpServer {
  readonly host: string;
  readonly port: number;
  readonly messages: readonly ReceivedEmail[];
  readonly authentications: readonly AuthenticationAttempt[];
  /** Adresses présentées dans une commande `RCPT TO`, acceptées ou non. */
  readonly recipientsSeen: readonly string[];
  /** Messages reçus par une adresse, du plus ancien au plus récent. */
  messagesTo(recipient: string): readonly ReceivedEmail[];
  /** Attend le `count`-ième message destiné à `recipient` et le retourne. */
  nextMessageTo(recipient: string, count?: number): Promise<ReceivedEmail>;
  close(): Promise<void>;
}

/**
 * Serveur SMTP réel, en mémoire, écoutant sur un port libre de la boucle locale. Il parle le
 * protocole comme le serveur d'un prestataire : négociation TLS, authentification, enveloppe.
 */
export async function startSmtpServer(
  options: TestSmtpServerOptions = {},
): Promise<TestSmtpServer> {
  const encryption = options.encryption ?? 'none';
  const messages: ReceivedEmail[] = [];
  const authentications: AuthenticationAttempt[] = [];
  const recipientsSeen: string[] = [];

  const server = new SMTPServer({
    secure: encryption === 'tls',
    ...(options.certificate ?? {}),
    disabledCommands: encryption === 'starttls' ? [] : ['STARTTLS'],
    authOptional: options.account === undefined,
    // Le serveur accepte des identifiants en clair : c'est au client de refuser de les envoyer.
    allowInsecureAuth: true,
    logger: false,
    closeTimeout: 500,
    onAuth(auth, session, callback) {
      const accepted =
        options.account !== undefined &&
        auth.username === options.account.user &&
        auth.password === options.account.password;
      authentications.push({
        user: auth.username ?? '',
        accepted,
        encrypted: session.secure,
      });
      if (accepted) {
        callback(null, { user: auth.username });
      } else {
        callback(new Error('Invalid username or password'));
      }
    },
    onRcptTo(address, _session, callback) {
      recipientsSeen.push(address.address);
      const refusal = options.recipientPolicy?.(address.address) ?? null;
      if (refusal === null) {
        callback();
        return;
      }
      callback(Object.assign(new Error(refusal.message), { responseCode: refusal.code }));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const raw = Buffer.concat(chunks);
        simpleParser(raw)
          .then((mail) => {
            messages.push({
              envelope: {
                from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
                to: session.envelope.rcptTo.map((recipient) => recipient.address),
              },
              raw: raw.toString('utf8'),
              mail,
              encrypted: session.secure,
              authenticatedAs: typeof session.user === 'string' ? session.user : null,
            });
            callback();
          })
          .catch((error: unknown) => {
            callback(error instanceof Error ? error : new Error('Unreadable message'));
          });
      });
    },
  });
  // Une connexion rompue par le client (refus du certificat, délai dépassé) n'est pas une
  // erreur du test.
  server.on('error', () => undefined);

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    const listener = server.listen(0, '127.0.0.1', () => {
      resolve((listener.address() as AddressInfo).port);
    });
  });

  const messagesTo = (recipient: string): readonly ReceivedEmail[] =>
    messages.filter((message) => message.envelope.to.includes(recipient));

  return {
    host: '127.0.0.1',
    port,
    messages,
    authentications,
    recipientsSeen,
    messagesTo,
    async nextMessageTo(recipient, count = 1) {
      await eventually(() => Promise.resolve(messagesTo(recipient).length >= count));
      const message = messagesTo(recipient)[count - 1];
      if (message === undefined) {
        throw new Error(`No email received by ${recipient}.`);
      }
      return message;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface TestCertificate {
  /** Certificat de l'autorité de test : à déclarer comme autorité de confiance du client. */
  readonly authority: string;
  /** Clé et certificat du serveur, émis par cette autorité pour `localhost` et `127.0.0.1`. */
  readonly server: { readonly key: string; readonly cert: string };
}

/**
 * Fabrique, pour la durée d'un test, une autorité de certification et un certificat de serveur
 * (commande `openssl`). Aucune clé n'est conservée dans le dépôt.
 */
export function createTestCertificate(): TestCertificate {
  const directory = mkdtempSync(join(tmpdir(), 'mgx-smtp-tls-'));
  const openssl = (...args: string[]): void => {
    execFileSync('openssl', args, { cwd: directory, stdio: 'pipe' });
  };
  const newKey = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  try {
    openssl(
      ...['req', '-x509', ...newKey, '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2'],
      ...['-subj', '/CN=MGX test authority'],
      ...['-addext', 'basicConstraints=critical,CA:TRUE'],
      ...['-addext', 'keyUsage=critical,keyCertSign'],
    );
    openssl(
      ...['req', ...newKey, '-keyout', 'server.key', '-out', 'server.csr'],
      ...['-subj', '/CN=localhost'],
    );
    writeFileSync(join(directory, 'san.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
    openssl(
      ...['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key'],
      ...['-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'san.cnf'],
    );
    return {
      authority: readFileSync(join(directory, 'ca.pem'), 'utf8'),
      server: {
        key: readFileSync(join(directory, 'server.key'), 'utf8'),
        cert: readFileSync(join(directory, 'server.pem'), 'utf8'),
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
