import type { RuntimeNotification } from '../cli/common/notification-interface.js';

export function isRuntimeNotificationLike(value: unknown): value is RuntimeNotification {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === 'string' && record.kind.length > 0;
}

export function runtimeNotificationsFromUnknownEvent(event: unknown): RuntimeNotification[] {
  if (!event || typeof event !== 'object') return [];
  const record = event as Record<string, unknown>;
  if (record.kind === 'notification-batch') {
    if (!Array.isArray(record.notifications)) return [];
    return record.notifications.filter(isRuntimeNotificationLike);
  }
  return isRuntimeNotificationLike(event) ? [event] : [];
}

export function filterFreshRuntimeNotifications(
  notifications: unknown[],
  nowMs: number,
  staleThresholdMs: number,
): { accepted: RuntimeNotification[]; rejected: number } {
  let rejected = 0;
  const accepted = notifications.filter((notification): notification is RuntimeNotification => {
    if (!isRuntimeNotificationLike(notification)) {
      rejected++;
      return false;
    }
    const record = notification as Record<string, unknown>;
    if (typeof record.sentAtMs === 'number' && nowMs - record.sentAtMs > staleThresholdMs) {
      rejected++;
      return false;
    }
    return true;
  });
  return { accepted, rejected };
}