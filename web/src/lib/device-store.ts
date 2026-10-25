// A choice kept on this device in localStorage, read by every view that shows it. A store that throws
// (private mode, a full quota) keeps the choice for the page's life; the default is never written.
import { useSyncExternalStore } from "react";

export function deviceStore<T>(key: string, parse: (raw: string | null) => T, isDefault: (value: T) => boolean, fallback: T): () => [T, (next: T) => void] {
  let parsed: { raw: string | null; value: T } | null = null;
  let memory: T | null = null;
  const listeners = new Set<() => void>();

  function read(): T {
    if (memory !== null) return memory;
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return fallback;
    }
    if (parsed?.raw !== raw) parsed = { raw, value: parse(raw) };
    return parsed.value;
  }

  function write(value: T): void {
    try {
      if (isDefault(value)) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
      memory = null;
    } catch {
      memory = value;
    }
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return () => [useSyncExternalStore(subscribe, read), write];
}
