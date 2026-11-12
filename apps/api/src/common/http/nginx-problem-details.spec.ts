import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';
import {
  ERROR_CODES,
  isErrorCode,
  PROBLEM_JSON_MEDIA_TYPE,
  problemDetailsSchema,
} from '@mgx/contracts';

/**
 * Nginx produit lui-même certaines erreurs : limitation de débit, corps trop volumineux, route
 * non relayée, API injoignable. Elles doivent suivre le même contrat que celles de l'API
 * (RFC 9457), sans quoi un client aurait deux formats à interpréter.
 *
 * Ce test lit la configuration du proxy et échoue dès qu'elle s'écarte du contrat.
 */
const NGINX_CONFIGURATION = readFileSync(
  fileURLToPath(new URL('../../../../../infrastructure/nginx/nginx.conf', import.meta.url)),
  'utf8',
);

/** Valeurs d'exemple des variables que Nginx substitue à l'exécution. */
const SAMPLE_VARIABLES: Readonly<Record<string, string>> = {
  $problem_instance: '/api/v1/system/status',
  $request_id: '0123456789abcdef0123456789abcdef',
  $problem_timestamp: '2026-01-31T12:00:00Z',
};

interface ProxyProblem {
  /** Bloc nommé de la configuration (`@problem_…`). */
  readonly location: string;
  readonly status: number;
  readonly mediaType: string | undefined;
  /** Corps de la réponse, variables Nginx non substituées. */
  readonly template: string;
}

/** Blocs `location @problem_… { … }` de la configuration. */
function proxyProblems(): ProxyProblem[] {
  const blocks = NGINX_CONFIGURATION.matchAll(/location (@problem_\w+) \{\n([\s\S]*?)\n {8}\}/g);

  return [...blocks].map(([, location = '', content = '']) => {
    const response = /return (\d{3}) '(.*)';/.exec(content);
    if (response === null) {
      throw new Error(`${location}: no "return <status> '<body>';" directive found`);
    }
    return {
      location,
      status: Number(response[1]),
      mediaType: /default_type (\S+);/.exec(content)?.[1],
      template: response[2] ?? '',
    };
  });
}

/** Statut final de chaque code intercepté par une directive `error_page`. */
function interceptedErrors(): { code: number; finalStatus: number; location: string }[] {
  const directives = NGINX_CONFIGURATION.matchAll(
    /error_page((?: \d{3})+)\s+(?:=(\d{3})\s+)?(@problem_\w+);/g,
  );

  return [...directives].flatMap(([, codes = '', override, location = '']) =>
    codes
      .trim()
      .split(' ')
      .map(Number)
      .map((code) => ({
        code,
        finalStatus: override === undefined ? code : Number(override),
        location,
      })),
  );
}

function render(template: string): string {
  return Object.entries(SAMPLE_VARIABLES).reduce(
    (body, [variable, value]) => body.replaceAll(variable, value),
    template,
  );
}

describe('Erreurs produites par Nginx', () => {
  const problems = proxyProblems();

  it('couvre la route inconnue, le corps trop volumineux, la limitation de débit et l’indisponibilité', () => {
    const covered = problems.map(({ status, template }) => {
      const body = problemDetailsSchema.parse(JSON.parse(render(template)));
      return `${String(status)} ${body.code}`;
    });

    expect(covered.sort()).toEqual([
      '404 NOT_FOUND',
      '413 PAYLOAD_TOO_LARGE',
      '429 RATE_LIMITED',
      '503 SERVICE_UNAVAILABLE',
    ]);
  });

  it.each(problems)('$location respecte le contrat d’erreur de l’API', (problem) => {
    expect(problem.mediaType).toBe(PROBLEM_JSON_MEDIA_TYPE);

    const rendered = render(problem.template);
    // Toute variable Nginx inconnue de ce test resterait dans le corps.
    expect(rendered).not.toContain('$');

    const body = problemDetailsSchema.parse(JSON.parse(rendered));
    expect(body.status).toBe(problem.status);
    expect(isErrorCode(body.code)).toBe(true);
    expect(ERROR_CODES[body.code].status).toBe(problem.status);
    expect(body.title).toBe(ERROR_CODES[body.code].title);
    expect(body.instance).toBe(SAMPLE_VARIABLES['$problem_instance']);
    expect(body.requestId).toBe(SAMPLE_VARIABLES['$request_id']);
    expect(body.timestamp).toBe(SAMPLE_VARIABLES['$problem_timestamp']);
  });

  it('le statut HTTP de chaque erreur interceptée est celui annoncé dans le corps', () => {
    const intercepted = interceptedErrors();
    expect(intercepted.map(({ code }) => code).sort()).toEqual([404, 413, 429, 502, 503, 504]);

    for (const { code, finalStatus, location } of intercepted) {
      const problem = problems.find((candidate) => candidate.location === location);
      expect({ code, location, status: problem?.status }).toEqual({
        code,
        location,
        status: finalStatus,
      });
    }
  });

  it('ne recopie dans le corps que des valeurs sans échappement JSON', () => {
    // `instance` : chemin filtré par une liste blanche, chaîne vide sinon — jamais `$uri` ni
    // `$request_uri`, qui peuvent contenir des guillemets ou la chaîne de requête.
    expect(NGINX_CONFIGURATION).toMatch(
      /map \$uri \$problem_instance \{\n\s+"~\^\(\?<safe_path>\[[^\]"\\]+\]\*\)\$"\s+\$safe_path;\n\s+default\s+"";\n\s+\}/,
    );
    expect(NGINX_CONFIGURATION).toContain('map $time_iso8601 $problem_timestamp {');

    for (const { template } of problems) {
      const variables = template.match(/\$\w+/g) ?? [];
      expect(Object.keys(SAMPLE_VARIABLES)).toEqual(expect.arrayContaining(variables));
    }
  });
});

describe('Ce que Nginx écrit sur son disque', () => {
  /** Directives en vigueur : lignes de la configuration, hors commentaires. */
  const directives = NGINX_CONFIGURATION.split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  it('aucune réponse de l’API : ni une pièce téléchargée, ni la copie des données d’un compte', () => {
    // Sans cette directive, une réponse plus grande que les tampons passe, en clair, par un
    // fichier temporaire. Elle vaut pour toutes les routes : elle est posée au niveau `http`,
    // et nulle part redéfinie. Le comportement réel est vérifié sur la pile complète (CI).
    const settings = directives.filter((line) => line.startsWith('proxy_max_temp_file_size'));
    expect(settings).toEqual(['proxy_max_temp_file_size 0;']);
    expect(directives.indexOf('proxy_max_temp_file_size 0;')).toBeLessThan(
      directives.indexOf('server {'),
    );
  });

  it('pas davantage le corps d’une pièce envoyée', () => {
    // Le bloc de la route d'envoi : de son en-tête à l'accolade qui le referme.
    const block =
      /location ~ "\^\/api\/v1\/me\/verification\/cases\/[^\n]*documents\$" \{\n(?<body>.*?)\n {8}\}/s.exec(
        NGINX_CONFIGURATION,
      );
    const body = (block?.groups?.['body'] ?? '').split('\n').map((line) => line.trim());
    expect(body).toContain('proxy_request_buffering off;');
    expect(body).toContain('proxy_pass http://mgx_api;');
  });
});
