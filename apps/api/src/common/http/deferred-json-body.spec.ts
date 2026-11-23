import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import { hasDeferredJsonBody, isParsedGlobally, readJsonBody } from './deferred-json-body.js';
import type { RawBodyLimits } from './raw-body.js';

const LIMITS: RawBodyLimits = { maxBytes: 1000, discardUpToBytes: 4000, timeoutMs: 2000 };
// `name` est rogné par le schéma : ce qui est rendu est la valeur validée, non la valeur reçue.
const schema = z.strictObject({ name: z.string().trim().min(1), count: z.number().int() });

const incoming = (method: string, url: string, contentType?: string): IncomingMessage =>
  ({
    method,
    url,
    headers: contentType === undefined ? {} : { 'content-type': contentType },
  }) as IncomingMessage;

describe('routes à corps JSON différé', () => {
  it.each([
    '/api/v1/admin/terms/versions',
    '/api/v1/admin/terms/versions/',
    '/api/v1/admin/terms/versions?dry=1',
    // Le routeur ne distingue pas la casse : la reconnaissance non plus.
    '/API/V1/Admin/Terms/Versions',
  ])('POST %s : le corps est lu par la route, pas par l’analyseur global', (url) => {
    expect(hasDeferredJsonBody(incoming('POST', url))).toBe(true);
    expect(isParsedGlobally(incoming('POST', url, 'application/json'))).toBe(false);
  });

  it.each([
    ['GET', '/api/v1/admin/terms/versions'],
    ['PUT', '/api/v1/admin/terms/versions'],
    ['POST', '/api/v1/admin/terms/versions/1'],
    ['POST', '/api/v1/admin/terms'],
    ['POST', '/api/v1/me/terms/acceptance'],
    ['POST', '/api/v2/admin/terms/versions'],
    ['POST', '/prefix/api/v1/admin/terms/versions'],
    ['POST', '/api/v1/admin/terms/versions/../../users'],
    ['POST', '/api/v1/auth/register'],
  ])('%s %s : route ordinaire, limite commune', (method, url) => {
    expect(hasDeferredJsonBody(incoming(method, url))).toBe(false);
    expect(isParsedGlobally(incoming(method, url, 'application/json'))).toBe(true);
  });

  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['APPLICATION/JSON', true],
    ['application/json;charset=UTF-8', true],
    ['application/jsonp', false],
    ['application/json-patch+json', false],
    ['text/json', false],
    ['text/plain', false],
    ['application/x-www-form-urlencoded', false],
    ['multipart/form-data; boundary=x', false],
    [undefined, false],
  ])('type de contenu %s : analysé comme du JSON → %s', (contentType, parsed) => {
    expect(isParsedGlobally(incoming('POST', '/api/v1/auth/login', contentType))).toBe(parsed);
  });

  it('une requête sans méthode ni adresse n’est pas différée', () => {
    expect(hasDeferredJsonBody({ headers: {} } as IncomingMessage)).toBe(false);
  });
});

describe('readJsonBody', () => {
  let server: Server;
  let port: number;
  /** Ce que le serveur fait de la requête avant de lire son corps. */
  let before: (request: IncomingMessage) => void = () => undefined;

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      before(request);
      readJsonBody(request as Request, response as Response, schema, LIMITS).then(
        (value) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ value }));
        },
        (error: unknown) => {
          const refusal =
            error instanceof AppError
              ? { code: error.code, detail: error.message, errors: error.errors ?? null }
              : { code: 'UNEXPECTED', detail: String(error), errors: null };
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify(refusal));
        },
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    // Une requête restée sans réponse ne doit pas retenir l'arrêt du serveur.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function send(
    body: Buffer | string,
    contentType: string | null = 'application/json',
  ): Promise<{ value?: unknown; code?: string; detail?: string; errors?: unknown }> {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
      method: 'POST',
      headers: contentType === null ? {} : { 'content-type': contentType },
      body: typeof body === 'string' ? body : new Uint8Array(body),
      // Sans réponse, le test échoue au lieu d'attendre.
      signal: AbortSignal.timeout(3000),
    });
    return (await response.json()) as { value?: unknown; code?: string };
  }

  it('lit, décode et valide le corps', async () => {
    before = () => undefined;
    expect(await send('{"name":"Arrêté — œuvre 😀","count":3}')).toEqual({
      value: { name: 'Arrêté — œuvre 😀', count: 3 },
    });
    // La valeur rendue est celle que le schéma a produite.
    expect(await send('{"name":"  rogné  ","count":2}')).toEqual({
      value: { name: 'rogné', count: 2 },
    });
    // Une marque d'ordre des octets en tête du document n'en fait pas partie.
    expect(
      await send(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"name":"a","count":1}')]),
      ),
    ).toEqual({ value: { name: 'a', count: 1 } });
  });

  it.each([['text/plain'], ['application/x-www-form-urlencoded'], ['application/jsonp'], [null]])(
    'type de contenu %s : refusé sans rien lire',
    async (contentType) => {
      before = () => undefined;
      expect(await send('{"name":"a","count":1}', contentType)).toMatchObject({
        code: 'UNSUPPORTED_MEDIA_TYPE',
        detail: 'The request body must be JSON.',
      });
    },
  );

  it.each([
    ['corps vide', ''],
    ['JSON tronqué', '{"name":"a",'],
    ['texte qui n’est pas du JSON', 'name=a&count=1'],
    [
      'octet invalide en UTF-8 (Latin-1)',
      Buffer.from('{"name":"Arr\u00eat\u00e9","count":1}', 'latin1'),
    ],
    [
      'séquence UTF-8 tronquée',
      Buffer.concat([
        Buffer.from('{"name":"'),
        Buffer.from([0xe2, 0x82]),
        Buffer.from('","count":1}'),
      ]),
    ],
    ['UTF-16', Buffer.from('{"name":"a","count":1}', 'utf16le')],
  ])('%s : MALFORMED_REQUEST', async (_label, body) => {
    before = () => undefined;
    expect(await send(body)).toMatchObject({
      code: 'MALFORMED_REQUEST',
      detail: 'The request body is not valid JSON.',
    });
  });

  it('un corps bien formé mais non conforme : VALIDATION_FAILED, champs désignés', async () => {
    before = () => undefined;
    expect(await send('{"name":"","count":1.5,"extra":true}')).toEqual({
      code: 'VALIDATION_FAILED',
      detail: 'Request validation failed.',
      errors: [
        { path: 'name', message: expect.any(String) },
        { path: 'count', message: expect.any(String) },
        { path: '', message: expect.any(String) },
      ],
    });
    for (const body of ['null', '[]', '"texte"', '42']) {
      expect(await send(body)).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('à la limite exacte, le corps est lu ; un octet de plus, il est refusé', async () => {
    before = () => undefined;
    const sized = (bytes: number): string => {
      const body = JSON.stringify({ name: 'x'.repeat(bytes - 21), count: 1 });
      expect(Buffer.byteLength(body)).toBe(bytes);
      return body;
    };
    expect(await send(sized(1000))).toMatchObject({ value: { count: 1 } });
    expect(await send(sized(1001))).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      detail: 'The request body exceeds the limit of 1000 bytes.',
    });
  });

  it('un corps déjà lu par l’analyseur global est repris tel qu’il l’a compris, puis validé', async () => {
    // Variante d'écriture du chemin que la reconnaissance n'aurait pas vue : l'analyseur
    // global a lu le corps, dans sa propre limite.
    before = (request) => {
      (request as unknown as Request).body = { name: ' déjà lu ', count: 2 };
      Object.defineProperty(request, 'readableEnded', { value: true });
    };
    expect(await send('{"ignored":true}')).toEqual({ value: { name: 'déjà lu', count: 2 } });

    before = (request) => {
      (request as unknown as Request).body = { name: '' };
      Object.defineProperty(request, 'readableEnded', { value: true });
    };
    expect(await send('{"ignored":true}')).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
