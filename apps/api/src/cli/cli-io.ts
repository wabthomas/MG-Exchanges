/** Codes de sortie de l'outil en ligne de commande. */
export const EXIT_OK = 0;
/** Erreur de l'opérateur : option, fichier ou variable d'environnement à corriger. */
export const EXIT_USAGE = 1;
/** Échec technique : base inaccessible, erreur inattendue. */
export const EXIT_FAILURE = 2;

/**
 * Ce qu'une commande reçoit du terminal et lui rend. Les commandes ne lisent ni n'écrivent
 * rien d'autre : elles se testent sans lancer de processus.
 */
export interface CliIo {
  /** Variables d'environnement. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Dossier depuis lequel s'entendent les chemins relatifs donnés en option. */
  readonly cwd: string;
  /** Écrit une ligne sur la sortie standard. */
  out(line: string): void;
  /** Écrit une ligne sur la sortie d'erreur. */
  err(line: string): void;
}

/** Variables d'environnement définies et non vides. */
export function definedVariables(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
    ),
  );
}
