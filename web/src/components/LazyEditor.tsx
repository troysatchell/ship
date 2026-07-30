import { lazy, Suspense, type ComponentProps } from 'react';
import { RouteFallback } from '@/components/RouteFallback';
import type { Editor as EditorComponent } from '@/components/Editor';

/**
 * The one shared `Editor`, behind a dynamic-import boundary (BUN-2 / TRO-198).
 *
 * This is NOT a second editor. It is the same `components/Editor`, deferred:
 * `@tiptap/*` + `prosemirror-*` + `yjs` + `lib0` + `y-*` + `linkifyjs` are
 * 726.5 kB raw / 208.7 kB gzip, and before this they were pulled statically by
 * every route that could *possibly* show an editor — including document types
 * that render a tab component and never mount one at all.
 *
 * Why the deferral is safe for collaboration: `Editor` creates its own
 * `Y.Doc`, `WebsocketProvider` and `IndexeddbPersistence` inside its own
 * effects, and neither consumer (`UnifiedEditor`, `PersonEditor`) holds a ref
 * to it or touches the Yjs document. Delaying the mount therefore delays
 * connection setup as a unit; it cannot interleave it. The `"Untitled"`
 * placeholder contract is likewise internal to `Editor` and unaffected —
 * `initialTitle` is still passed through verbatim.
 *
 * The fallback deliberately uses the `panel` variant: `Editor` renders into
 * the main-content column and portals its properties into the always-present
 * `#properties-portal` aside, so the 4-panel layout stays intact while the
 * chunk loads.
 *
 * `ComponentProps<typeof EditorComponent>` keeps the prop contract in one
 * place — the type import is erased at build time, so it does not pull the
 * editor stack back into the parent chunk.
 */
const Editor = lazy(() => import('@/components/Editor').then((m) => ({ default: m.Editor })));

export type LazyEditorProps = ComponentProps<typeof EditorComponent>;

export function LazyEditor(props: LazyEditorProps) {
  return (
    <Suspense fallback={<RouteFallback variant="panel" />}>
      <Editor {...props} />
    </Suspense>
  );
}
