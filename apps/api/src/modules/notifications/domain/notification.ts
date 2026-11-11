import type { SupportedLocale } from '@mgx/validation';

/** Contenu d'un message : un modèle et les valeurs qu'il attend. */
export type NotificationContent =
  | {
      readonly template: 'email_verification_code';
      readonly code: string;
      readonly ttlMinutes: number;
    }
  | { readonly template: 'password_reset_code'; readonly code: string; readonly ttlMinutes: number }
  | { readonly template: 'account_already_exists' }
  | { readonly template: 'password_changed' };

export type NotificationTemplate = NotificationContent['template'];

/** Canaux de remise. Seul l'e-mail est utilisé pour l'instant ; le SMS viendra avec la vérification du téléphone. */
export type NotificationChannel = 'EMAIL';

export interface NotificationMessage {
  readonly channel: NotificationChannel;
  /** Adresse du destinataire sur le canal choisi. */
  readonly recipient: string;
  readonly locale: SupportedLocale;
  readonly content: NotificationContent;
}

/** Message prêt à être remis : objet et texte rédigés dans la langue du destinataire. */
export interface RenderedNotification {
  readonly channel: NotificationChannel;
  readonly recipient: string;
  readonly template: NotificationTemplate;
  readonly locale: SupportedLocale;
  readonly subject: string;
  readonly text: string;
}
