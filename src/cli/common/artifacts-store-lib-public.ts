/**
 * artifacts-store-lib-public.ts
 *
 * Public API wrapper for ArtifactsStore, following CommandInput/CommandResult.
 */

import type { CommandInput, CommandResult } from './board-live-cards-public.js';
import type { ArtifactInfo, ArtifactsStore } from './artifacts-store-lib.js';

export interface ArtifactsStorePublic {
  list(input: CommandInput): CommandResult<{ artifacts: ArtifactInfo[] }>;
  head(input: CommandInput): CommandResult<{ artifact: ArtifactInfo | null }>;
  put(input: CommandInput): CommandResult<{ artifact: ArtifactInfo }>;
  get(input: CommandInput): CommandResult<{ key: string; contentType?: string; size?: number; text?: string; bytes?: number[] }>;
  del(input: CommandInput): CommandResult<{ ok: true }>;
}

export function createArtifactsStorePublic(store: ArtifactsStore): ArtifactsStorePublic {
  function ok<T>(data: T): CommandResult<T> {
    return { status: 'success', data } as CommandResult<T>;
  }
  function fail<T>(error: string): CommandResult<T> {
    return { status: 'fail', error } as CommandResult<T>;
  }
  function oops<T>(e: unknown): CommandResult<T> {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) } as CommandResult<T>;
  }

  return {
    list(input: CommandInput): CommandResult<{ artifacts: ArtifactInfo[] }> {
      try {
        const prefix = (input.params?.['prefix'] as string | undefined) ?? '';
        return ok({ artifacts: store.list(prefix) });
      } catch (e) { return oops(e); }
    },

    head(input: CommandInput): CommandResult<{ artifact: ArtifactInfo | null }> {
      try {
        const key = input.params?.['key'] as string | undefined;
        if (!key) return fail('head requires params.key');
        return ok({ artifact: store.head(key) });
      } catch (e) { return oops(e); }
    },

    put(input: CommandInput): CommandResult<{ artifact: ArtifactInfo }> {
      try {
        const key = input.params?.['key'] as string | undefined;
        const contentType = input.params?.['contentType'] as string | undefined;
        if (!key) return fail('put requires params.key');

        const body = input.body;
        if (typeof body === 'string') {
          return ok({ artifact: store.putText(key, body, contentType) });
        }

        if (body && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string') {
          return ok({ artifact: store.putText(key, (body as { text: string }).text, contentType) });
        }

        if (body && typeof body === 'object' && Array.isArray((body as { bytes?: unknown }).bytes)) {
          const byteValues = (body as { bytes: number[] }).bytes;
          const bytes = new Uint8Array(byteValues.map((n) => Math.max(0, Math.min(255, Number(n) || 0))));
          return ok({ artifact: store.putBytes(key, bytes, contentType) });
        }

        return fail('put requires body as string, {text}, or {bytes:number[]}');
      } catch (e) { return oops(e); }
    },

    get(input: CommandInput): CommandResult<{ key: string; contentType?: string; size?: number; text?: string; bytes?: number[] }> {
      try {
        const key = input.params?.['key'] as string | undefined;
        const as = (input.params?.['as'] as string | undefined) ?? 'base64';
        if (!key) return fail('get requires params.key');

        const head = store.head(key);
        if (!head) return fail(`artifact "${key}" not found`);

        if (as === 'text') {
          const text = store.getText(key);
          if (text === null) return fail(`artifact "${key}" not found`);
          return ok({ key, contentType: head.contentType, size: head.size, text });
        }

        const bytes = store.getBytes(key);
        if (bytes === null) return fail(`artifact "${key}" not found`);
        return ok({ key, contentType: head.contentType, size: head.size, bytes: [...bytes] });
      } catch (e) { return oops(e); }
    },

    del(input: CommandInput): CommandResult<{ ok: true }> {
      try {
        const key = input.params?.['key'] as string | undefined;
        if (!key) return fail('del requires params.key');
        store.remove(key);
        return ok({ ok: true });
      } catch (e) { return oops(e); }
    },
  };
}
