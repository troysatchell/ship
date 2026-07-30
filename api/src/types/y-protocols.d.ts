declare module 'y-protocols/sync' {
  import * as Y from 'yjs';
  import * as encoding from 'lib0/encoding';
  import * as decoding from 'lib0/decoding';

  export function writeSyncStep1(encoder: encoding.Encoder, doc: Y.Doc): void;
  export function writeSyncStep2(encoder: encoding.Encoder, doc: Y.Doc, encodedStateVector?: Uint8Array): void;
  export function readSyncStep1(decoder: decoding.Decoder, encoder: encoding.Encoder, doc: Y.Doc): void;
  // `transactionOrigin` is caller-defined and opaque to the sync protocol itself
  // (this codebase passes a `WebSocket` or `null`) — `unknown` rather than `any`
  // so a caller must narrow before doing anything with it.
  export function readSyncStep2(decoder: decoding.Decoder, doc: Y.Doc, transactionOrigin?: unknown): void;
  export function readSyncMessage(
    decoder: decoding.Decoder,
    encoder: encoding.Encoder,
    doc: Y.Doc,
    transactionOrigin: unknown
  ): number;
  export function writeUpdate(encoder: encoding.Encoder, update: Uint8Array): void;
}

declare module 'y-protocols/awareness' {
  import * as Y from 'yjs';

  /**
   * Payload of the awareness `'update'`/`'change'` events: which client ids
   * were added, updated, or removed from the shared state map. See
   * `y-protocols/awareness`'s `emit('update', [{ added, updated, removed }, origin])`.
   */
  export interface AwarenessChange {
    added: number[];
    updated: number[];
    removed: number[];
  }

  export class Awareness {
    doc: Y.Doc;
    clientID: number;
    // Each client's awareness state is an arbitrary JSON-like object it chose
    // to publish (cursor position, user info, ...) — genuinely dynamic, so
    // `unknown` values rather than `any`.
    states: Map<number, Record<string, unknown>>;
    constructor(doc: Y.Doc);
    getStates(): Map<number, Record<string, unknown>>;
    getLocalState(): Record<string, unknown> | null;
    setLocalState(state: Record<string, unknown> | null): void;
    setLocalStateField(field: string, value: unknown): void;
    // Typed for the one event this codebase actually listens for, plus a
    // loose fallback for anything else — a fully untyped variadic callback
    // would have accepted a mistyped 'update' handler just as silently as it
    // typed a correct one.
    on(event: 'update' | 'change', callback: (change: AwarenessChange, origin: unknown) => void): void;
    on(event: string, callback: (...args: unknown[]) => void): void;
    off(event: 'update' | 'change', callback: (change: AwarenessChange, origin: unknown) => void): void;
    off(event: string, callback: (...args: unknown[]) => void): void;
    destroy(): void;
  }

  export function encodeAwarenessUpdate(awareness: Awareness, clients: number[]): Uint8Array;
  export function applyAwarenessUpdate(awareness: Awareness, update: Uint8Array, origin: unknown): void;
  export function removeAwarenessStates(awareness: Awareness, clients: number[], origin: unknown): void;
}
