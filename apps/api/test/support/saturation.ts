import type { PrismaService } from '../../src/infrastructure/database/prisma.service.js';

/**
 * Occupe `count` connexions du pool de `prisma`, chacune tenue par une transaction ouverte qui
 * ne fait rien, et rend la main une fois toutes prises. La fonction rendue les libère.
 *
 * Rien ne repose sur une durée : les connexions restent prises tant que le test ne les rend
 * pas — une saturation provoquée ainsi ne dépend ni de la machine, ni du disque.
 */
export async function occupyConnections(
  prisma: PrismaService,
  count: number,
): Promise<() => Promise<void>> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const taken: Promise<void>[] = [];
  const holders = Array.from({ length: count }, () => {
    let took: () => void = () => undefined;
    taken.push(
      new Promise<void>((resolve) => {
        took = resolve;
      }),
    );
    return prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        took();
        await released;
      },
      // Une tâche de fond peut tenir une connexion un instant : l'occupant l'attend. Et il
      // la garde au-delà des cinq secondes qu'une transaction a d'ordinaire.
      { maxWait: 10_000, timeout: 60_000 },
    );
  });
  // Si l'un des occupants échoue, le dire plutôt que d'attendre sans fin.
  await Promise.race([Promise.all(taken), Promise.all(holders)]);
  return async () => {
    release();
    await Promise.all(holders);
  };
}
