import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo, connect } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { AppError } from '../errors/app-error.js';
import { BoundedBody, type RawBodyLimits, readRawBody } from './raw-body.js';

const LIMITS: RawBodyLimits = { maxBytes: 1000, discardUpToBytes: 4000, timeoutMs: 2000 };

interface Outcome {
  readonly code: string;
  readonly detail?: string;
  readonly length?: number;
  readonly sha256?: string;
  /** Écouteurs laissés sur la requête une fois la lecture terminée. */
  readonly listeners: number;
}

const sha256 = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');

describe('BoundedBody', () => {
  const chunk = (size: number, fill: number): Buffer => Buffer.alloc(size, fill);

  it('garde ce qui tient dans la limite, et le rend à l’identique', () => {
    const body = new BoundedBody(10);
    body.add(chunk(4, 1));
    body.add(chunk(6, 2));

    expect(body.receivedBytes).toBe(10);
    expect(body.retainedBytes).toBe(10);
    expect(body.overflowed).toBe(false);
    expect(body.toBuffer()).toEqual(Buffer.concat([chunk(4, 1), chunk(6, 2)]));
  });

  it('dès la limite dépassée, ne garde plus rien — ni ce qui précède, ni ce qui suit', () => {
    const body = new BoundedBody(10);
    body.add(chunk(8, 1));
    expect(body.retainedBytes).toBe(8);

    // Le fragment qui fait déborder n'est pas gardé, et libère ce qui l'était.
    body.add(chunk(3, 2));
    expect(body.overflowed).toBe(true);
    expect(body.retainedBytes).toBe(0);

    // La suite est comptée, jamais conservée : la mémoire ne dépend plus de ce qui arrive.
    for (let index = 0; index < 50; index += 1) {
      body.add(chunk(1000, 3));
      expect(body.retainedBytes).toBe(0);
    }
    expect(body.receivedBytes).toBe(50_011);
    expect(() => body.toBuffer()).toThrow('A body that exceeded its limit was not retained.');
  });

  it('un seul fragment plus grand que la limite n’est pas gardé', () => {
    const body = new BoundedBody(10);
    body.add(chunk(11, 1));

    expect(body.overflowed).toBe(true);
    expect(body.retainedBytes).toBe(0);
  });

  it('abandonne sur demande ce qui était gardé', () => {
    const body = new BoundedBody(10);
    body.add(chunk(7, 1));
    body.discard();

    expect(body.retainedBytes).toBe(0);
    expect(body.receivedBytes).toBe(7);
  });
});

describe('readRawBody', () => {
  let server: Server;
  let port: number;
  let limits: RawBodyLimits = LIMITS;
  /** Ce que le serveur fait de la requête avant de lire son corps. */
  let before: (request: IncomingMessage) => Promise<void> = () => Promise.resolve();
  /** Issue de la dernière lecture, vue du serveur — y compris quand le client est parti. */
  let lastOutcome: Promise<Outcome>;
  let settle: (outcome: Outcome) => void = () => undefined;

  const listenersOf = (request: IncomingMessage): number =>
    request.listenerCount('data') +
    request.listenerCount('end') +
    request.listenerCount('error') +
    request.listenerCount('close');

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const baseline = listenersOf(request);
    let outcome: Outcome;
    try {
      await before(request);
      const body = await readRawBody(request, response, limits);
      outcome = {
        code: 'OK',
        length: body.length,
        sha256: sha256(body),
        listeners: listenersOf(request) - baseline,
      };
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }
      outcome = {
        code: error.code,
        detail: error.message,
        listeners: listenersOf(request) - baseline,
      };
    }
    settle(outcome);
    if (!response.destroyed) {
      response.statusCode = outcome.code === 'OK' ? 200 : 400;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(outcome));
    }
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      void handle(request, response);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  /**
   * Écrit une requête telle quelle et retourne la réponse brute, lue jusqu'à ce que le serveur
   * ferme la connexion ou que le client raccroche. `parts` sont écrits l'un après l'autre,
   * espacés de `pauseMs`.
   */
  function exchange(
    head: readonly string[],
    parts: readonly Buffer[],
    options: { pauseMs?: number; hangUpAfterMs?: number; keepOpenMs?: number } = {},
  ): Promise<{ raw: string; outcome: Outcome | null; closedByServer: boolean }> {
    lastOutcome = new Promise<Outcome>((resolve) => {
      settle = resolve;
    });
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      const chunks: Buffer[] = [];
      let hungUp = false;
      const guard = setTimeout(() => {
        socket.destroy();
        reject(new Error('The server neither answered nor closed the connection.'));
      }, 8000);

      socket.on('connect', () => {
        socket.write([...head, '', ''].join('\r\n'));
        void (async () => {
          for (const part of parts) {
            if (socket.destroyed) {
              return;
            }
            socket.write(part);
            if (options.pauseMs !== undefined) {
              await new Promise((done) => setTimeout(done, options.pauseMs));
            }
          }
        })();
        if (options.hangUpAfterMs !== undefined) {
          setTimeout(() => {
            hungUp = true;
            socket.destroy();
          }, options.hangUpAfterMs);
        }
        if (options.keepOpenMs !== undefined) {
          // Le client attend la réponse puis raccroche de lui-même.
          setTimeout(() => {
            hungUp = true;
            socket.end();
          }, options.keepOpenMs);
        }
      });
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('error', () => undefined);
      socket.on('close', () => {
        clearTimeout(guard);
        const raw = Buffer.concat(chunks).toString('latin1');
        const json = /\r\n\r\n(\{.*\})/s.exec(raw)?.[1];
        resolve({
          raw,
          outcome: json === undefined ? null : (JSON.parse(json) as Outcome),
          closedByServer: !hungUp,
        });
      });
    });
  }

  const post = (length: number | null, extra: readonly string[] = []): string[] => [
    'POST /upload HTTP/1.1',
    'Host: localhost',
    'Content-Type: image/jpeg',
    ...(length === null ? ['Transfer-Encoding: chunked'] : [`Content-Length: ${String(length)}`]),
    ...extra,
  ];
  const chunked = (content: Buffer): Buffer =>
    Buffer.concat([
      Buffer.from(`${content.length.toString(16)}\r\n`),
      content,
      Buffer.from('\r\n'),
    ]);
  const LAST_CHUNK = Buffer.from('0\r\n\r\n');
  const bytes = (length: number, fill = 0x41): Buffer => Buffer.alloc(length, fill);

  /** Rétablit le comportement par défaut du serveur ; chaque test pose ensuite le sien. */
  const reset = (): void => {
    limits = LIMITS;
    before = () => Promise.resolve();
  };

  it('rend le corps à l’identique, qu’il arrive d’un bloc ou par morceaux', async () => {
    reset();
    const content = Buffer.from(Array.from({ length: 900 }, (_, index) => index % 251));

    const whole = await exchange(post(900, ['Connection: close']), [content]);
    expect(whole.outcome).toEqual({
      code: 'OK',
      length: 900,
      sha256: sha256(content),
      listeners: 0,
    });

    const pieces = await exchange(
      post(900, ['Connection: close']),
      [content.subarray(0, 300), content.subarray(300, 301), content.subarray(301)],
      { pauseMs: 20 },
    );
    expect(pieces.outcome).toMatchObject({ code: 'OK', length: 900, sha256: sha256(content) });

    const streamed = await exchange(post(null, ['Connection: close']), [
      chunked(content.subarray(0, 500)),
      chunked(content.subarray(500)),
      LAST_CHUNK,
    ]);
    expect(streamed.outcome).toMatchObject({ code: 'OK', length: 900, sha256: sha256(content) });
  });

  it('un corps vide est un corps : zéro octet', async () => {
    reset();
    const empty = await exchange(post(0, ['Connection: close']), []);
    expect(empty.outcome).toMatchObject({ code: 'OK', length: 0 });
  });

  it('accepte exactement la taille maximale et refuse un octet de plus', async () => {
    reset();
    const atLimit = await exchange(post(1000, ['Connection: close']), [bytes(1000)]);
    expect(atLimit.outcome).toMatchObject({ code: 'OK', length: 1000 });

    const oneMore = await exchange(post(1001, ['Connection: close']), [bytes(1001)]);
    expect(oneMore.outcome).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      detail: 'The request body exceeds the limit of 1000 bytes.',
      listeners: 0,
    });
  });

  it('un peu trop grand : le surplus est lu sans être gardé, et la connexion reste utilisable', async () => {
    reset();
    // Deux requêtes sur la même connexion : la première est refusée, la seconde aboutit.
    const first = [...post(3000), '', ''].join('\r\n');
    const second = [...post(5, ['Connection: close']), '', ''].join('\r\n');
    lastOutcome = new Promise<Outcome>((resolve) => {
      settle = resolve;
    });
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      const chunks: Buffer[] = [];
      const guard = setTimeout(() => {
        socket.destroy();
        reject(new Error('No answer.'));
      }, 8000);
      socket.on('connect', () => {
        socket.write(first);
        socket.write(bytes(3000));
        socket.write(second);
        socket.write(Buffer.from('hello'));
      });
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('error', () => undefined);
      socket.on('close', () => {
        clearTimeout(guard);
        resolve(Buffer.concat(chunks).toString('latin1'));
      });
    });

    const answers = [...raw.matchAll(/\{[^{}]*\}/g)].map(
      (match) => JSON.parse(match[0]) as Outcome,
    );
    expect(answers).toEqual([
      {
        code: 'PAYLOAD_TOO_LARGE',
        detail: 'The request body exceeds the limit of 1000 bytes.',
        listeners: 0,
      },
      { code: 'OK', length: 5, sha256: sha256(Buffer.from('hello')), listeners: 0 },
    ]);
    // La première réponse n'a pas demandé la fermeture de la connexion.
    expect(raw.split('HTTP/1.1')[1]).not.toMatch(/Connection: close/i);
  });

  it('démesuré d’après son en-tête : refusé sans rien lire, et la connexion est fermée', async () => {
    reset();
    const startedAt = Date.now();
    // 4001 octets annoncés, 10 envoyés : la réponse n'attend pas la suite.
    const refused = await exchange(post(4001), [bytes(10)]);

    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(refused.outcome).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      detail: 'The request body exceeds the limit of 1000 bytes.',
      listeners: 0,
    });
    expect(refused.raw).toMatch(/\r\nConnection: close\r\n/i);
    expect(refused.closedByServer).toBe(true);

    // Exactement le plafond : encore lu jusqu'au bout, sans fermeture.
    const atCeiling = await exchange(post(4000, ['Connection: close']), [bytes(4000)]);
    expect(atCeiling.outcome).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', listeners: 0 });
  });

  it('démesuré sans l’annoncer (envoi par morceaux) : coupé dès que le plafond est franchi', async () => {
    reset();
    const refused = await exchange(
      post(null),
      // 5 × 1000 octets : le plafond de 4000 est franchi au cinquième, les suivants ne sont pas lus.
      Array.from({ length: 50 }, () => chunked(bytes(1000))),
      { pauseMs: 10 },
    );

    expect(refused.outcome).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', listeners: 0 });
    expect(refused.raw).toMatch(/\r\nConnection: close\r\n/i);
    expect(refused.closedByServer).toBe(true);
  });

  it('un corps qui tarde trop est abandonné : la connexion est fermée', async () => {
    reset();
    limits = { ...LIMITS, timeoutMs: 150 };
    const startedAt = Date.now();
    const slow = await exchange(post(900), [bytes(100)]);

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(1500);
    expect(slow.outcome).toEqual({
      code: 'REQUEST_TIMEOUT',
      detail: 'The request body took too long to arrive.',
      listeners: 0,
    });
    expect(slow.raw).toMatch(/\r\nConnection: close\r\n/i);
    expect(slow.closedByServer).toBe(true);
  });

  it('le délai court pour le corps entier, pas entre deux morceaux', async () => {
    reset();
    limits = { ...LIMITS, timeoutMs: 200 };
    // Un morceau toutes les 60 ms : aucun silence n'atteint 200 ms, mais l'ensemble les dépasse.
    const trickle = await exchange(
      post(900),
      Array.from({ length: 9 }, () => bytes(100)),
      { pauseMs: 60 },
    );
    expect(trickle.outcome).toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });

  it('un corps reçu à temps n’est pas rattrapé par le délai ensuite', async () => {
    reset();
    limits = { ...LIMITS, timeoutMs: 150 };
    const quick = await exchange(post(100), [bytes(100)], { keepOpenMs: 400 });
    expect(quick.outcome).toMatchObject({ code: 'OK', length: 100, listeners: 0 });
    // Une seule réponse : le délai, désarmé, n'a rien écrit après coup.
    expect(quick.raw.match(/HTTP\/1\.1/g)).toHaveLength(1);
  });

  it('un envoi interrompu par le client est signalé, sans rien garder', async () => {
    reset();
    const interrupted = await exchange(post(900), [bytes(100)], { hangUpAfterMs: 100 });
    expect(interrupted.raw).toBe('');
    await expect(lastOutcome).resolves.toEqual({
      code: 'MALFORMED_REQUEST',
      detail: 'The request body was interrupted.',
      listeners: 0,
    });
  });

  it('un corps déjà lu par un autre ne se lit pas deux fois', async () => {
    reset();
    before = async (request) => {
      request.resume();
      await new Promise((resolve) => request.once('end', resolve));
    };
    const consumed = await exchange(post(100, ['Connection: close']), [bytes(100)]);
    expect(consumed.outcome).toEqual({
      code: 'MALFORMED_REQUEST',
      detail: 'The request body could not be read.',
      listeners: 0,
    });
  });

  it('rien n’est lu tant que la fonction n’est pas appelée : un refus préalable ne coûte rien', async () => {
    reset();
    let receivedBeforeReading = -1;
    before = async (request) => {
      // Le temps que le client ait tout envoyé.
      await new Promise((resolve) => setTimeout(resolve, 150));
      receivedBeforeReading = request.readableLength;
      expect(request.readableFlowing).toBeNull();
    };
    const late = await exchange(post(900, ['Connection: close']), [bytes(900)]);
    // Le flux n'a pas été consommé pendant l'attente ; le corps est ensuite lu en entier.
    expect(receivedBeforeReading).toBeGreaterThanOrEqual(0);
    expect(late.outcome).toMatchObject({ code: 'OK', length: 900 });
  });
});
