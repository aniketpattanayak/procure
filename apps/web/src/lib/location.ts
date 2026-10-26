'use client';
/**
 * Current working location (top-bar switcher), persisted per user in localStorage.
 * Phase 4 lists read `useCurrentLocation()`; `null` means "All locations" within the user's scope.
 */
import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
const keyFor = (userId: string) => `procure.location.${userId}`;

function read(userId: string | null | undefined): string | null {
  if (!userId || typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(keyFor(userId)); } catch { return null; }
}

export function setCurrentLocation(userId: string, nodeId: string | null) {
  try {
    if (nodeId) window.localStorage.setItem(keyFor(userId), nodeId);
    else window.localStorage.removeItem(keyFor(userId));
  } catch { /* storage blocked: keep in memory for this page only */ memory.set(userId, nodeId); }
  listeners.forEach(l => l());
}

const memory = new Map<string, string | null>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key?.startsWith('procure.location.')) cb(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(cb); window.removeEventListener('storage', onStorage); };
}

/** Selected location node id for this user, or null for all. */
export function useCurrentLocationId(userId: string | null | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (userId && memory.has(userId) ? memory.get(userId)! : read(userId)),
    () => null,
  );
}
