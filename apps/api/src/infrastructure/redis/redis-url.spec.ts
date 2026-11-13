import { describe, expect, it } from '@jest/globals';

import { parseRedisUrl } from './redis-url.js';

describe('parseRedisUrl', () => {
  it('décompose une URL simple', () => {
    expect(parseRedisUrl('redis://localhost:6379/0')).toEqual({
      host: 'localhost',
      port: 6379,
      db: 0,
    });
    expect(parseRedisUrl('redis://cache.internal')).toEqual({ host: 'cache.internal', port: 6379 });
  });

  it('lit les identifiants (décodés) et active TLS pour rediss://', () => {
    expect(parseRedisUrl('rediss://app:p%40ss%2Fword@redis.example.com:6380/3')).toEqual({
      host: 'redis.example.com',
      port: 6380,
      username: 'app',
      password: 'p@ss/word',
      db: 3,
      tls: {},
    });
    expect(parseRedisUrl('redis://:only-password@localhost')).toEqual({
      host: 'localhost',
      port: 6379,
      password: 'only-password',
    });
  });

  it('refuse un schéma ou une base invalides sans divulguer l’URL', () => {
    expect(() => parseRedisUrl('http://user:secret@localhost')).toThrow(
      'Redis URL must use the redis:// or rediss:// scheme.',
    );
    expect(() => parseRedisUrl('redis://localhost/cache')).toThrow(
      'Redis URL database must be a non-negative integer.',
    );
  });
});
