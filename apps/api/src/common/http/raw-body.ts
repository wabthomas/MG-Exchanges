import type { IncomingMessage, ServerResponse } from 'node:http';

import { AppError } from '../errors/app-error.js';

export interface RawBodyLimits {
  /** Taille maximale acceptée. Au-delà, la requête est refusée (`PAYLOAD_TOO_LARGE`). */
  readonly maxBytes: number;
  /**
   * Taille au-delà de laquelle la connexion est fermée sans attendre la fin de l'envoi. Entre
   * `maxBytes` et ce plafond, le surplus est lu sans être conservé, pour que le client reçoive
   * une réponse d'erreur lisible plutôt qu'une coupure en plein envoi.
   */
  readonly discardUpToBytes: number;
  /** Délai accordé pour recevoir le corps entier. */
  readonly timeoutMs: number;
}

function tooLarge(maxBytes: number): AppError {
  return new AppError(
    'PAYLOAD_TOO_LARGE',
    `The request body exceeds the limit of ${String(maxBytes)} bytes.`,
  );
}

/**
 * Accumule les fragments d'un corps tant qu'il tient dans la limite. Dès qu'il la dépasse,
 * tout ce qui avait été gardé est abandonné et plus rien n'est conservé : la mémoire occupée
 * ne dépasse jamais `maxBytes`, quelle que soit la quantité reçue.
 */
export class BoundedBody {
  private chunks: Buffer[] = [];
  private received = 0;

  constructor(private readonly maxBytes: number) {}

  /** Nombre d'octets reçus, conservés ou non. */
  get receivedBytes(): number {
    return this.received;
  }

  /** Nombre d'octets actuellement gardés en mémoire. */
  get retainedBytes(): number {
    return this.chunks.reduce((total, chunk) => total + chunk.length, 0);
  }

  /** Vrai dès que le corps a dépassé la limite : il ne sera pas rendu. */
  get overflowed(): boolean {
    return this.received > this.maxBytes;
  }

  add(chunk: Buffer): void {
    this.received += chunk.length;
    if (this.overflowed) {
      this.chunks = [];
    } else {
      this.chunks.push(chunk);
    }
  }

  /** Abandonne ce qui a été gardé. */
  discard(): void {
    this.chunks = [];
  }

  /** Le corps entier. */
  toBuffer(): Buffer {
    if (this.overflowed) {
      throw new Error('A body that exceeded its limit was not retained.');
    }
    return Buffer.concat(this.chunks, this.received);
  }
}

/**
 * Lit le corps brut d'une requête, borné en taille et en durée.
 *
 * À n'appeler qu'**après** les contrôles qui peuvent refuser la requête (authentification,
 * droits, quotas) : tant que cette fonction n'est pas appelée, rien n'est lu ni gardé en
 * mémoire. La mémoire utilisée ne dépasse jamais `maxBytes`.
 *
 * @throws AppError `PAYLOAD_TOO_LARGE`, `REQUEST_TIMEOUT`, ou `MALFORMED_REQUEST` si l'envoi
 *   est interrompu ou si le corps a déjà été lu.
 */
export function readRawBody(
  request: IncomingMessage,
  response: ServerResponse,
  limits: RawBodyLimits,
): Promise<Buffer> {
  const { maxBytes, discardUpToBytes, timeoutMs } = limits;

  return new Promise<Buffer>((resolve, reject) => {
    if (request.readableEnded || request.destroyed) {
      reject(new AppError('MALFORMED_REQUEST', 'The request body could not be read.'));
      return;
    }

    const body = new BoundedBody(maxBytes);
    const timer = setTimeout(() => {
      refuse(new AppError('REQUEST_TIMEOUT', 'The request body took too long to arrive.'));
    }, timeoutMs);

    function stopListening(): void {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onInterrupted);
      request.off('close', onInterrupted);
    }

    /**
     * Refuse sans lire la suite : la réponse part avec `Connection: close`, et la connexion
     * est fermée dès qu'elle est écrite — le reste du corps n'est jamais lu.
     */
    function refuse(error: AppError): void {
      stopListening();
      body.discard();
      request.pause();
      if (!response.headersSent) {
        response.setHeader('Connection', 'close');
      }
      reject(error);
    }

    function onData(chunk: Buffer): void {
      // Trop grand : ce qui a été reçu est abandonné, le reste est lu sans être conservé.
      body.add(chunk);
      if (body.receivedBytes > discardUpToBytes) {
        refuse(tooLarge(maxBytes));
      }
    }

    function onEnd(): void {
      stopListening();
      if (body.overflowed) {
        reject(tooLarge(maxBytes));
      } else {
        resolve(body.toBuffer());
      }
    }

    function onInterrupted(): void {
      stopListening();
      body.discard();
      reject(new AppError('MALFORMED_REQUEST', 'The request body was interrupted.'));
    }

    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > discardUpToBytes) {
      refuse(tooLarge(maxBytes));
      return;
    }

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onInterrupted);
    request.once('close', onInterrupted);
  });
}
