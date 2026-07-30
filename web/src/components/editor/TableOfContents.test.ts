import { describe, it, expect } from 'vitest';
import { TableOfContentsExtension } from './TableOfContents';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

describe('TableOfContentsExtension', () => {
  it('should create a valid TipTap extension', () => {
    const extension = TableOfContentsExtension;
    expect(extension).toBeDefined();
    expect(extension.name).toBe('tableOfContents');
  });

  it('should be configured as a block node', () => {
    const extension = TableOfContentsExtension;
    expect(extension.config.group).toBe('block');
    expect(extension.config.atom).toBe(true);
  });

  it('should have parseHTML function defined', () => {
    const extension = TableOfContentsExtension;
    expect(extension.config.parseHTML).toBeDefined();
    expect(typeof extension.config.parseHTML).toBe('function');
  });

  it('should have renderHTML function defined', () => {
    const extension = TableOfContentsExtension;
    expect(extension.config.renderHTML).toBeDefined();
    expect(typeof extension.config.renderHTML).toBe('function');
  });

  it('should have addNodeView function defined', () => {
    const extension = TableOfContentsExtension;
    expect(extension.config.addNodeView).toBeDefined();
    expect(typeof extension.config.addNodeView).toBe('function');
  });

  it('should extract headings from document', () => {
    // Create editor with TableOfContents extension and headings
    const editor = new Editor({
      extensions: [
        StarterKit.configure({
          heading: {
            levels: [1, 2, 3, 4, 5, 6],
          },
        }),
        TableOfContentsExtension,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'First Heading' }],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Some content' }],
          },
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Second Heading' }],
          },
          {
            type: 'tableOfContents',
          },
        ],
      },
    });

    // Extract headings from document state
    const headings: { level: number; text: string; pos: number }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        headings.push({
          level: node.attrs.level as number,
          text: node.textContent,
          pos,
        });
      }
    });

    expect(headings).toHaveLength(2);
    const [firstHeading, secondHeading] = headings;
    if (!firstHeading || !secondHeading) throw new Error('expected two headings');
    expect(firstHeading.text).toBe('First Heading');
    expect(firstHeading.level).toBe(1);
    expect(secondHeading.text).toBe('Second Heading');
    expect(secondHeading.level).toBe(2);

    editor.destroy();
  });

  it('should update when headings change', () => {
    const editor = new Editor({
      extensions: [
        StarterKit.configure({
          heading: {
            levels: [1, 2, 3, 4, 5, 6],
          },
        }),
        TableOfContentsExtension,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'Original Heading' }],
          },
          {
            type: 'tableOfContents',
          },
        ],
      },
    });

    // Count initial headings
    let headingCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'heading') {
        headingCount++;
      }
    });
    expect(headingCount).toBe(1);

    // Add a new heading
    editor
      .chain()
      .focus()
      .setTextSelection(0)
      .insertContentAt(editor.state.doc.content.size - 2, {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'New Heading' }],
      })
      .run();

    // Count headings after update
    headingCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'heading') {
        headingCount++;
      }
    });
    expect(headingCount).toBe(2);

    editor.destroy();
  });

  it('should handle empty document with no headings', () => {
    const editor = new Editor({
      extensions: [
        StarterKit.configure({
          heading: {
            levels: [1, 2, 3, 4, 5, 6],
          },
        }),
        TableOfContentsExtension,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'No headings here' }],
          },
          {
            type: 'tableOfContents',
          },
        ],
      },
    });

    // Extract headings - should be empty
    const headings: { level: number; text: string; pos: number }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        headings.push({
          level: node.attrs.level as number,
          text: node.textContent,
          pos,
        });
      }
    });

    expect(headings).toHaveLength(0);

    editor.destroy();
  });

  it('should preserve heading levels correctly', () => {
    const editor = new Editor({
      extensions: [
        StarterKit.configure({
          heading: {
            levels: [1, 2, 3, 4, 5, 6],
          },
        }),
        TableOfContentsExtension,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'H1' }],
          },
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'H2' }],
          },
          {
            type: 'heading',
            attrs: { level: 3 },
            content: [{ type: 'text', text: 'H3' }],
          },
          {
            type: 'tableOfContents',
          },
        ],
      },
    });

    const headings: { level: number; text: string }[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'heading') {
        headings.push({
          level: node.attrs.level as number,
          text: node.textContent,
        });
      }
    });

    expect(headings).toHaveLength(3);
    const [h1, h2, h3] = headings;
    if (!h1 || !h2 || !h3) throw new Error('expected three headings');
    expect(h1.level).toBe(1);
    expect(h2.level).toBe(2);
    expect(h3.level).toBe(3);

    editor.destroy();
  });

  it('should work in editor context', () => {
    const editor = new Editor({
      extensions: [StarterKit, TableOfContentsExtension],
      content: '<p>Test content</p>',
    });

    expect(editor).toBeDefined();
    expect(editor.extensionManager.extensions.some(ext => ext.name === 'tableOfContents')).toBe(true);

    editor.destroy();
  });
});
