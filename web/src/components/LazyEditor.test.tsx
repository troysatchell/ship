import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { staticValueImports } from '@/test/sourceImports';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * TRO-198 / BUN-2 — `@tiptap/*` + `prosemirror-*` + `yjs` + `lib0` + `y-*` +
 * `linkifyjs` are 726.5 kB raw / 208.7 kB gzip, and `components/Editor` was
 * imported statically by `UnifiedEditor` and `PersonEditor`. Every route that
 * *could* show an editor paid for it up front — including document types that
 * render a tab component and never mount one at all.
 *
 * This is the riskiest of the bundle fixes, and the two named risks are:
 *
 *  - Yjs / WebSocket mount timing. `Editor` builds its own `Y.Doc`,
 *    `WebsocketProvider` and `IndexeddbPersistence` inside its own effects and
 *    neither consumer holds a ref to it, so deferring the mount defers the
 *    whole setup as a unit. What must not change is that the mount still
 *    happens, with the props intact.
 *  - The `"Untitled"` placeholder contract. `Editor` compares `initialTitle`
 *    against that exact literal to apply placeholder styling
 *    (docs/document-model-conventions.md). A wrapper that normalised, trimmed
 *    or defaulted the title would break it silently — nothing would throw, the
 *    placeholder would just stop appearing.
 *
 * The editor module itself is mocked here: mounting real TipTap + Yjs in jsdom
 * proves nothing about the split and a great deal about jsdom. What is being
 * tested is the boundary — that it resolves, and that it is transparent.
 */

const editorProps = vi.fn();

vi.mock('@/components/Editor', () => ({
  Editor: (props: Record<string, unknown>) => {
    editorProps(props);
    return <div data-testid="editor-mounted">{String(props.initialTitle)}</div>;
  },
}));

/**
 * A fresh module instance per test. `React.lazy` memoises its payload after
 * the first resolution, so a second render of the *same* lazy component never
 * shows a fallback — which would make any fallback assertion silently
 * order-dependent. Resetting the module registry gives each test its own
 * `lazy()` call and therefore a real pending state.
 */
async function loadLazyEditor() {
  vi.resetModules();
  return (await import('./LazyEditor')).LazyEditor;
}

describe('LazyEditor (TRO-198 / BUN-2)', () => {
  beforeEach(() => editorProps.mockClear());

  it('mounts the shared Editor once its chunk resolves', async () => {
    const LazyEditor = await loadLazyEditor();
    render(<LazyEditor documentId="doc-1" userName="Ada" />);

    // Before the chunk lands the boundary shows a fallback, not nothing and
    // not a thrown "lazy component with no Suspense boundary".
    expect(screen.getByRole('status')).toHaveTextContent('Loading');

    expect(await screen.findByTestId('editor-mounted')).toBeInTheDocument();
    expect(editorProps).toHaveBeenCalledTimes(1);
  });

  it('passes "Untitled" through verbatim, preserving the placeholder contract', async () => {
    const LazyEditor = await loadLazyEditor();
    render(<LazyEditor documentId="doc-1" userName="Ada" initialTitle="Untitled" />);

    await screen.findByTestId('editor-mounted');
    // Not "Untitled Document", not trimmed to "", not defaulted away.
    expect(screen.getByTestId('editor-mounted')).toHaveTextContent(/^Untitled$/);
    expect(editorProps.mock.calls[0][0]).toMatchObject({ initialTitle: 'Untitled' });
  });

  it('forwards every prop unchanged, including the collaboration room prefix', async () => {
    const LazyEditor = await loadLazyEditor();
    const onTitleChange = vi.fn();
    render(
      <LazyEditor
        documentId="doc-42"
        userName="Ada"
        roomPrefix="person"
        placeholder="Add bio, contact info, skills..."
        onTitleChange={onTitleChange}
        documentType="wiki"
      />
    );

    await screen.findByTestId('editor-mounted');
    // roomPrefix and documentId together select the collaboration room
    // (/collaboration/{docType}:{docId}); dropping either would connect the
    // editor to the wrong document, which no size measurement would catch.
    expect(editorProps.mock.calls[0][0]).toMatchObject({
      documentId: 'doc-42',
      userName: 'Ada',
      roomPrefix: 'person',
      placeholder: 'Add bio, contact info, skills...',
      documentType: 'wiki',
      onTitleChange,
    });
  });

  it('uses the panel fallback, so the properties sidebar and rails stay put', async () => {
    const LazyEditor = await loadLazyEditor();
    render(<LazyEditor documentId="doc-1" userName="Ada" />);
    // h-full, not h-screen: the editor renders into the main-content column and
    // portals its properties into the always-present #properties-portal aside.
    expect(screen.getByRole('status').className).toContain('h-full');
    expect(screen.getByRole('status').className).not.toContain('h-screen');
    await screen.findByTestId('editor-mounted');
  });

  it('unmounts the fallback rather than stacking it above the editor', async () => {
    const LazyEditor = await loadLazyEditor();
    render(<LazyEditor documentId="doc-1" userName="Ada" />);
    await screen.findByTestId('editor-mounted');
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('keeps the one shared Editor — consumers import the wrapper, not a second editor', () => {
    // Ship's rule is one Editor for every document type. LazyEditor is that
    // same component behind a boundary; the failure mode this guards is a
    // consumer going back to the static import (undoing the split) or someone
    // introducing a type-specific editor alongside it.
    const unified = readFileSync(resolve(here, 'UnifiedEditor.tsx'), 'utf8');
    const person = readFileSync(resolve(here, '../pages/PersonEditor.tsx'), 'utf8');

    // Detection via src/test/sourceImports.ts, which is tested against every
    // import form. The regex previously inlined here matched only a
    // single-quoted named import, so a default or namespace import of
    // components/Editor would have passed while undoing the split.
    for (const [name, src] of [['UnifiedEditor', unified], ['PersonEditor', person]] as const) {
      expect(
        staticValueImports(src),
        `${name} should not statically import components/Editor`
      ).not.toContain('@/components/Editor');
      expect(
        staticValueImports(src),
        `${name} should render the shared Editor via LazyEditor`
      ).toContain('@/components/LazyEditor');
    }

    const wrapper = readFileSync(resolve(here, 'LazyEditor.tsx'), 'utf8');
    expect(wrapper).toContain("lazy(() => import('@/components/Editor')");
    // A value-level import here would pull the whole TipTap/Yjs stack back into
    // the parent chunk while the lazy() call still looked correct. The type
    // import is erased at build time, so it is allowed — and must be the only
    // reference.
    expect(wrapper).toMatch(/import type \{ Editor as EditorComponent \} from '@\/components\/Editor';/);
    expect(staticValueImports(wrapper)).not.toContain('@/components/Editor');
  });
});
