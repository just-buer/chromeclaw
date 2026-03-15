/**
 * Keep-alive alarm manager for Chrome MV3 service workers.
 *
 * Chrome's service worker can be suspended after 30 s of inactivity.
 * A periodic alarm prevents this while streams or background tasks are active.
 *
 * On Firefox the background page is persistent — alarms are unnecessary,
 * so all methods become no-ops.
 */

import { IS_FIREFOX } from '@extension/env';

interface KeepAliveManager {
  /** Increment the active-task counter and create the alarm if first. */
  acquire: () => void;
  /** Decrement the counter and clear the alarm when it reaches zero. */
  release: () => void;
  /** Clear any orphaned alarm from a previous SW crash (call at module init). */
  clearOrphan: () => void;
}

/**
 * Create a browser-agnostic keep-alive manager.
 * On Firefox every method is a no-op (persistent background page).
 */
const createKeepAliveManager = (alarmName: string): KeepAliveManager => {
  if (IS_FIREFOX) {
    return { acquire: () => {}, release: () => {}, clearOrphan: () => {} };
  }

  let refCount = 0;

  return {
    acquire() {
      refCount++;
      if (refCount === 1) {
        chrome.alarms.create(alarmName, { periodInMinutes: 0.4 });
      }
    },
    release() {
      refCount = Math.max(0, refCount - 1);
      if (refCount === 0) {
        chrome.alarms.clear(alarmName);
      }
    },
    clearOrphan() {
      chrome.alarms.clear(alarmName);
    },
  };
};

export { createKeepAliveManager };
export type { KeepAliveManager };
