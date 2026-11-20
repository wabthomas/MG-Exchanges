/**
 * Le titulaire d'un portefeuille doit être informé de l'ajustement qui vient d'y être passé. La
 * charge ne porte que l'identifiant de l'ajustement : qui la consomme le relit — ni montant, ni
 * adresse ne transitent par la boîte d'envoi.
 */
export const ADJUSTMENT_NOTICE_REQUESTED_EVENT = 'ledger_adjustment.notice_requested';
