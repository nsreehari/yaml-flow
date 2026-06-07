import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createFsQueueStorage } from '../../src/cli/node/storage-fs-adapters.js';
import { createQueueStoragePublic } from '../../src/cli/common/queue-storage-public.js';
import type { RuntimeNotification, RuntimeNotificationBatch } from '../../src/cli/common/notification-interface.js';

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const tmpDir = tmpDirs.pop();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function makeQueue(notifications: Array<RuntimeNotification | RuntimeNotificationBatch>) {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-storage-public-'));
  tmpDirs.push(queueDir);
  return createQueueStoragePublic(createFsQueueStorage(queueDir), {
    lane: 'test-lane',
    emitNotification(notification) {
      notifications.push(notification);
    },
  });
}

describe('queue-storage public notifications', () => {
  it('emits message_enqueued only for enqueue operations and staged commits', () => {
    const notifications: Array<RuntimeNotification | RuntimeNotificationBatch> = [];
    const queue = makeQueue(notifications);

    const queued = queue.enqueue({ task: 'one' });
    const queuedMany = queue.enqueueMany([{ task: 'two' }, { task: 'three' }]);
    const dedupQueued = queue.enqueueIfAbsent?.({ task: 'four' }, 'dedup-1');
    const dedupSkipped = queue.enqueueIfAbsent?.({ task: 'four-duplicate' }, 'dedup-1');
    const staged = queue.stage({ task: 'staged' }, { dedupKey: 'stage-1' });
    const stagedForDiscard = queue.stage({ task: 'discard' }, { dedupKey: 'stage-2' });

    expect(queue.peekActive().map((message) => message.id)).toEqual([
      queued.id,
      ...queuedMany.map((message) => message.id),
      dedupQueued?.id,
    ].filter(Boolean));

    expect(queue.commitStaged(staged!.id)).toBe(true);
    expect(queue.discardStaged(stagedForDiscard!.id, 'cancelled')).toBe(true);

    const leased = queue.lease<{ task: string }>({ max: 1 });
    expect(leased).toHaveLength(1);
    expect(queue.nack(leased[0].id, leased[0].leaseToken)).toBe(true);
    const reLeased = queue.lease<{ task: string }>({ max: 1 });
    expect(reLeased).toHaveLength(1);
    expect(queue.ack(reLeased[0].id, reLeased[0].leaseToken)).toBe(true);
    queue.peekDeadLetter();
    queue.peekStaged();

    expect(dedupSkipped).toBeNull();
    expect(notifications).toEqual([
      expect.objectContaining({
        category: 'queue-storage',
        kind: 'message_enqueued',
        lane: 'test-lane',
        message: expect.objectContaining({ id: queued.id, body: { task: 'one' } }),
      }),
      expect.objectContaining({
        category: 'batch',
        kind: 'notification-batch',
        notifications: [
          expect.objectContaining({
            category: 'queue-storage',
            kind: 'message_enqueued',
            lane: 'test-lane',
            message: expect.objectContaining({ id: queuedMany[0].id, body: { task: 'two' } }),
          }),
          expect.objectContaining({
            category: 'queue-storage',
            kind: 'message_enqueued',
            lane: 'test-lane',
            message: expect.objectContaining({ id: queuedMany[1].id, body: { task: 'three' } }),
          }),
        ],
      }),
      expect.objectContaining({
        category: 'queue-storage',
        kind: 'message_enqueued',
        lane: 'test-lane',
        message: expect.objectContaining({ id: dedupQueued?.id, body: { task: 'four' } }),
      }),
      expect.objectContaining({
        category: 'queue-storage',
        kind: 'message_enqueued',
        lane: 'test-lane',
        message: expect.objectContaining({ id: staged!.id, body: { task: 'staged' } }),
      }),
    ]);
  });

  it('does not emit when enqueueIfAbsent is dedup-blocked or staged operations fail', () => {
    const notifications: Array<RuntimeNotification | RuntimeNotificationBatch> = [];
    const queue = makeQueue(notifications);

    expect(queue.enqueueIfAbsent?.({ task: 'one' }, 'dedup')).toEqual(expect.objectContaining({ body: { task: 'one' } }));
    expect(queue.enqueueIfAbsent?.({ task: 'duplicate' }, 'dedup')).toBeNull();
    expect(queue.commitStaged('missing')).toBe(false);
    expect(queue.discardStaged('missing', 'nope')).toBe(false);

    expect(notifications).toHaveLength(1);
  });
});