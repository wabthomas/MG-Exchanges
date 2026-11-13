import { createTransport } from 'nodemailer';

import type { SmtpConfig } from '../../../config/app-config.js';
import type { NotificationChannel, RenderedNotification } from '../domain/notification.js';
import { NotificationSender } from '../application/notification-sender.js';

/** Délais au-delà desquels une étape de la connexion SMTP est abandonnée (millisecondes). */
export interface SmtpTimeouts {
  readonly dnsMs: number;
  readonly connectionMs: number;
  readonly greetingMs: number;
  /** Inactivité de la connexion une fois établie. */
  readonly socketMs: number;
}

export const DEFAULT_SMTP_TIMEOUTS: SmtpTimeouts = {
  dnsMs: 5000,
  connectionMs: 10_000,
  greetingMs: 10_000,
  socketMs: 30_000,
};

export interface SmtpSenderOptions extends SmtpConfig {
  readonly timeouts?: SmtpTimeouts;
  /**
   * Autorités de certification acceptées, au format PEM, à la place de celles de Node.js.
   * Réservé aux tests : en exploitation, un relais interne signé par une autorité privée se
   * déclare à Node.js par `NODE_EXTRA_CA_CERTS`.
   */
  readonly trustedCa?: string;
}

/** Journal minimal attendu par l'expéditeur (compatible avec `PinoLogger`). */
export interface SmtpLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** Ce que l'on retient d'un échec SMTP : jamais d'adresse, jamais de contenu. */
export interface SmtpFailure {
  /** Code de l'erreur (`EAUTH`, `ECONNECTION`, `ETIMEDOUT`, `EENVELOPE`, `EMESSAGE`…). */
  readonly code: string;
  /** Commande SMTP en cours lorsque le serveur a répondu par une erreur. */
  readonly command: string | null;
  readonly responseCode: number | null;
  /** Réponse du serveur, adresses masquées. */
  readonly serverReply: string | null;
  /** Vrai si le serveur a refusé définitivement le destinataire lui-même. */
  readonly recipientRefused: boolean;
}

/**
 * Échec de la remise d'un e-mail au serveur SMTP. Le message ne contient ni l'adresse du
 * destinataire ni le texte envoyé : il peut être journalisé tel quel.
 */
export class SmtpDeliveryError extends Error {
  readonly code: string;
  readonly command: string | null;
  readonly responseCode: number | null;

  constructor(failure: SmtpFailure) {
    super(
      `SMTP delivery failed (${failure.code}${failure.command === null ? '' : ` during ${failure.command}`})` +
        (failure.serverReply === null ? '.' : `: ${failure.serverReply}`),
    );
    this.name = 'SmtpDeliveryError';
    this.code = failure.code;
    this.command = failure.command;
    this.responseCode = failure.responseCode;
  }
}

/**
 * Une adresse, et une seule : ni séparateur de liste, ni chevron, ni espace, ni caractère de
 * contrôle. La bibliothèque SMTP lit un destinataire comme une **liste** d'adresses et en
 * extrait ce qui y ressemble ; elle ne doit jamais recevoir autre chose qu'une adresse nue.
 */
const SINGLE_ADDRESS = /^[^\s\p{Cc}<>()[\]\\,;:"@]+@[^\s\p{Cc}<>()[\]\\,;:"@]+$/u;

/** Vrai si `value` désigne exactement un destinataire. */
export function isSingleAddress(value: string): boolean {
  return SINGLE_ADDRESS.test(value);
}

const ADDRESS_LIKE = /[^\s<>()[\]"',;:]+@[^\s<>()[\]"',;:]+/gu;
const SERVER_REPLY_MAX_LENGTH = 300;

/**
 * Réduit une erreur de la bibliothèque SMTP à ce qui peut être journalisé. La réponse d'un
 * serveur cite souvent l'adresse refusée : tout ce qui ressemble à une adresse y est masqué.
 */
export function describeSmtpFailure(error: unknown): SmtpFailure {
  const source = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    command?: unknown;
    response?: unknown;
    responseCode?: unknown;
    permanent?: unknown;
  };
  const code = typeof source.code === 'string' ? source.code : 'UNKNOWN';
  const command = typeof source.command === 'string' ? source.command : null;
  const serverReply =
    typeof source.response === 'string'
      ? source.response
          .replace(ADDRESS_LIKE, '<address>')
          .replace(/\s+/gu, ' ')
          .trim()
          .slice(0, SERVER_REPLY_MAX_LENGTH)
      : null;
  return {
    code,
    command,
    responseCode: typeof source.responseCode === 'number' ? source.responseCode : null,
    serverReply,
    // Refus définitif (5xx) du destinataire : boîte inexistante, domaine refusé. Un refus de
    // l'expéditeur (`MAIL FROM`) ou du message (`DATA`) est, lui, un défaut de notre côté.
    recipientRefused: code === 'EENVELOPE' && command === 'RCPT TO' && source.permanent === true,
  };
}

/** Options de connexion transmises à la bibliothèque SMTP. */
export function smtpTransportOptions(options: SmtpSenderOptions) {
  const timeouts = options.timeouts ?? DEFAULT_SMTP_TIMEOUTS;
  return {
    host: options.host,
    port: options.port,
    // `tls` : chiffrée dès l'ouverture. `starttls` : la bibliothèque refuse de poursuivre —
    // et donc d'envoyer identifiants ou message — si le serveur ne passe pas en TLS.
    secure: options.security === 'tls',
    requireTLS: options.security === 'starttls',
    ...(options.auth === null
      ? {}
      : { auth: { user: options.auth.user, pass: options.auth.password } }),
    tls: {
      minVersion: 'TLSv1.2' as const,
      ...(options.trustedCa === undefined ? {} : { ca: options.trustedCa }),
    },
    dnsTimeout: timeouts.dnsMs,
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    // Le contenu des messages n'est jamais lu depuis un fichier ni une URL.
    disableFileAccess: true,
    disableUrlAccess: true,
    // La bibliothèque journaliserait les échanges, adresses et contenu compris.
    logger: false,
  };
}

/**
 * Remise des e-mails par le serveur SMTP d'un prestataire — le protocole que tous proposent :
 * changer de prestataire ne demande qu'un changement de configuration.
 *
 * Les SMS ne passent pas par ici : ce canal reste indisponible tant qu'aucun prestataire SMS
 * n'est branché.
 */
export class SmtpNotificationSender extends NotificationSender {
  private readonly transport: ReturnType<typeof createTransport>;

  constructor(
    private readonly options: SmtpSenderOptions,
    private readonly logger: SmtpLogger,
  ) {
    super();
    this.transport = createTransport(smtpTransportOptions(options));
  }

  supports(channel: NotificationChannel): boolean {
    return channel === 'EMAIL';
  }

  async deliver(notification: RenderedNotification): Promise<void> {
    if (notification.channel !== 'EMAIL') {
      throw new Error(
        `No delivery is configured for ${notification.channel} messages (template "${notification.template}").`,
      );
    }

    // Les adresses sont validées à l'inscription ; cette vérification ne dépend pas d'elle.
    if (!isSingleAddress(notification.recipient)) {
      throw new Error(
        `Refusing to send: the recipient is not a single email address (template "${notification.template}").`,
      );
    }

    const { from } = this.options;
    try {
      const info = (await this.transport.sendMail({
        from: { name: from.name ?? '', address: from.address },
        to: { name: '', address: notification.recipient },
        // L'enveloppe est fixée explicitement : un seul destinataire, quoi que contienne son adresse.
        envelope: { from: from.address, to: [notification.recipient] },
        subject: notification.subject,
        text: notification.text,
        headers: {
          // Message automatique : les répondeurs et les notifications d'absence l'ignorent.
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
          'Content-Language': notification.locale,
        },
      })) as { messageId?: string };
      this.logger.info(
        { template: notification.template, messageId: info.messageId },
        'Email accepted by the SMTP server',
      );
    } catch (error) {
      const failure = describeSmtpFailure(error);
      if (failure.recipientRefused) {
        // Adresse inexistante ou refusée : réessayer ne changerait rien, et insister nuirait à
        // la réputation de l'expéditeur. Même issue qu'un message accepté puis retourné.
        this.logger.warn(
          {
            template: notification.template,
            responseCode: failure.responseCode,
            serverReply: failure.serverReply,
          },
          'Email refused by the SMTP server for this recipient',
        );
        return;
      }
      throw new SmtpDeliveryError(failure);
    }
  }

  /**
   * Au démarrage, vérifie en arrière-plan que le serveur répond et accepte les identifiants :
   * une configuration fautive se voit dans le journal dès le déploiement, pas à la première
   * inscription. Un serveur injoignable n'empêche pas l'API de démarrer.
   */
  onApplicationBootstrap(): void {
    void this.verify();
  }

  /** @returns vrai si le serveur a répondu et accepté les identifiants. */
  async verify(): Promise<boolean> {
    try {
      await this.transport.verify();
      this.logger.info(
        { host: this.options.host, port: this.options.port, security: this.options.security },
        'SMTP server is reachable and accepts the configured credentials',
      );
      return true;
    } catch (error) {
      const failure = describeSmtpFailure(error);
      this.logger.error(
        {
          host: this.options.host,
          port: this.options.port,
          code: failure.code,
          command: failure.command,
          responseCode: failure.responseCode,
          serverReply: failure.serverReply,
        },
        'SMTP server verification failed: emails cannot be sent',
      );
      return false;
    }
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
