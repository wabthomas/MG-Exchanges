/**
 * Une des deux parties d'un transfert doit en être informée. La charge ne porte que
 * l'identifiant du transfert et la partie à prévenir : qui la consomme relit le transfert — ni
 * montant, ni adresse ne transitent par la boîte d'envoi. Un événement par message : l'échec de
 * l'un ne fait pas renvoyer l'autre.
 */
export const TRANSFER_NOTICE_REQUESTED_EVENT = 'transfer.notice_requested';

/** Les deux parties d'un transfert. */
export const TRANSFER_PARTIES = ['SENDER', 'RECIPIENT'] as const;
export type TransferParty = (typeof TRANSFER_PARTIES)[number];
