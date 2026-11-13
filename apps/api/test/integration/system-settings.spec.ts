import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { AppError } from '../../src/common/errors/app-error.js';
import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../src/infrastructure/database/unit-of-work.js';
import { AuditService } from '../../src/modules/audit/application/audit.service.js';
import { OutboxService } from '../../src/modules/outbox/application/outbox.service.js';
import { SystemSettingsService } from '../../src/modules/system-settings/application/system-settings.service.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const ADMIN = { type: 'USER', id: 'admin-1' } as const;

describe('Paramètres système (PostgreSQL réel)', () => {
  let testApp: TestApp;
  let settings: SystemSettingsService;
  let prisma: PrismaService;

  beforeAll(async () => {
    testApp = await createTestApp();
    settings = testApp.app.get(SystemSettingsService);
    prisma = testApp.app.get(PrismaService);
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('toutes les fonctionnalités sont désactivées tant qu’aucune décision n’a été enregistrée', async () => {
    const snapshot = await settings.getSnapshot();
    expect(snapshot.maintenance).toEqual({ enabled: false, message: null });
    expect(Object.values(snapshot.features).every((enabled) => !enabled)).toBe(true);
    expect(await prisma.systemSetting.count()).toBe(0);
  });

  it('une modification écrit ensemble la valeur, l’entrée d’audit et l’événement', async () => {
    await settings.setFeatureEnabled('exchange', true, {
      actor: ADMIN,
      requestId: 'req-settings-0001',
      reason: 'Regulatory approval received',
    });

    expect(await settings.isFeatureEnabled('exchange')).toBe(true);
    expect(await settings.isFeatureEnabled('p2p')).toBe(false);

    const stored = await prisma.systemSetting.findUniqueOrThrow({
      where: { key: 'features.exchange' },
    });
    expect(stored).toMatchObject({ value: true, version: 1 });

    const audit = await prisma.auditLog.findMany({ where: { resourceId: 'features.exchange' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'USER',
      actorId: 'admin-1',
      action: 'system_setting.updated',
      resourceType: 'system_setting',
      outcome: 'SUCCESS',
      requestId: 'req-settings-0001',
      metadata: {
        previousValue: null,
        newValue: true,
        version: 1,
        reason: 'Regulatory approval received',
      },
    });

    const events = await prisma.outboxEvent.findMany({
      where: { aggregateId: 'features.exchange' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateType: 'system_setting',
      eventType: 'system_setting.changed',
      payload: { key: 'features.exchange', version: 1 },
    });
  });

  it('refuse une valeur invalide sans rien écrire', async () => {
    const before = await prisma.auditLog.count();

    await expect(
      settings.set('maintenance.mode', { enabled: 'yes' } as never, { actor: ADMIN }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_ENTITY' });
    await expect(
      settings.set('features.p2p', 'true' as never, { actor: ADMIN }),
    ).rejects.toBeInstanceOf(AppError);

    expect(await prisma.auditLog.count()).toBe(before);
    expect(await prisma.systemSetting.findUnique({ where: { key: 'features.p2p' } })).toBeNull();
  });

  it('sérialise les modifications concurrentes d’une même clé : aucune version perdue', async () => {
    const changes = 12;
    await Promise.all(
      Array.from({ length: changes }, (_unused, index) =>
        settings.set(
          'maintenance.mode',
          { enabled: index % 2 === 0, message: `change ${index}` },
          { actor: ADMIN },
        ),
      ),
    );

    const stored = await prisma.systemSetting.findUniqueOrThrow({
      where: { key: 'maintenance.mode' },
    });
    expect(stored.version).toBe(changes);

    const audit = await prisma.auditLog.findMany({
      where: { resourceId: 'maintenance.mode' },
      orderBy: { id: 'asc' },
    });
    const versions = audit.map((entry) => (entry.metadata as { version: number }).version);
    expect([...versions].sort((a, b) => a - b)).toEqual(
      Array.from({ length: changes }, (_unused, index) => index + 1),
    );

    // Chaque entrée d'audit décrit exactement la transition observée : la valeur « avant »
    // de la version n est la valeur « après » de la version n − 1.
    const byVersion = new Map(
      audit.map((entry) => {
        const metadata = entry.metadata as {
          version: number;
          previousValue: unknown;
          newValue: unknown;
        };
        return [metadata.version, metadata] as const;
      }),
    );
    for (let version = 2; version <= changes; version += 1) {
      expect(byVersion.get(version)?.previousValue).toEqual(byVersion.get(version - 1)?.newValue);
    }
    expect(byVersion.get(changes)?.newValue).toEqual(stored.value);

    await settings.set('maintenance.mode', { enabled: false, message: null }, { actor: ADMIN });
  });

  it('une transaction annulée ne laisse ni audit ni événement', async () => {
    const unitOfWork = testApp.app.get(UnitOfWork);
    const audit = testApp.app.get(AuditService);
    const outbox = testApp.app.get(OutboxService);
    const marker = 'rollback-probe';

    await expect(
      unitOfWork.run(async (tx) => {
        await audit.record(tx, {
          actor: { type: 'SYSTEM' },
          action: 'probe.attempted',
          resource: { type: 'probe', id: marker },
          outcome: 'SUCCESS',
        });
        await outbox.append(tx, {
          aggregateType: 'probe',
          aggregateId: marker,
          eventType: 'probe.attempted',
          payload: {},
        });
        throw new Error('business operation failed');
      }),
    ).rejects.toThrow('business operation failed');

    expect(await prisma.auditLog.count({ where: { resourceId: marker } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: marker } })).toBe(0);
  });

  it('expurge les secrets des métadonnées d’audit avant écriture', async () => {
    const audit = testApp.app.get(AuditService);
    await audit.record(prisma, {
      actor: { type: 'SERVICE', id: 'provider-x' },
      action: 'probe.recorded',
      resource: { type: 'probe', id: 'redaction' },
      outcome: 'SUCCESS',
      metadata: {
        password: 'hunter2',
        nested: { accessToken: 'abc.def.ghi', amount: '12.50' },
        header: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
      },
    });

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: 'redaction' } });
    expect(entry.metadata).toEqual({
      password: '[REDACTED]',
      nested: { accessToken: '[REDACTED]', amount: '12.50' },
      header: '[REDACTED]',
    });
    expect(JSON.stringify(entry)).not.toContain('hunter2');
  });

  it('refuse une action d’audit mal formée (erreur de programmation)', async () => {
    const audit = testApp.app.get(AuditService);
    await expect(
      audit.record(prisma, {
        actor: { type: 'SYSTEM' },
        action: 'NotAnAction',
        resource: { type: 'probe' },
        outcome: 'SUCCESS',
      }),
    ).rejects.toThrow(/Invalid audit action/);
  });
});
