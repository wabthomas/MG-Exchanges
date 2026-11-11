export interface RedisConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly db?: number;
  /** Présent (objet vide) lorsque l'URL utilise `rediss://` : connexion chiffrée TLS. */
  readonly tls?: Record<string, never>;
}

/** Décompose une URL `redis://` ou `rediss://` en options de connexion. */
export function parseRedisUrl(url: string): RedisConnectionOptions {
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('Redis URL must use the redis:// or rediss:// scheme.');
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (database !== '' && !/^\d+$/.test(database)) {
    throw new Error('Redis URL database must be a non-negative integer.');
  }

  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    ...(parsed.username === '' ? {} : { username: decodeURIComponent(parsed.username) }),
    ...(parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) }),
    ...(database === '' ? {} : { db: Number(database) }),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
