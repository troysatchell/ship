import { describe, expect, it, vi } from 'vitest';
import { buildGraph, NODE_NAMES, type AnthropicModel } from '../graph.js';

function fakeModel(response: string): AnthropicModel {
  return { invoke: vi.fn().mockResolvedValue({ content: response }) };
}

describe('buildGraph', () => {
  it('compiles and exposes every declared node in its node set', () => {
    const compiled = buildGraph(fakeModel('fake reply'));
    const nodeKeys = Object.keys(compiled.nodes);

    for (const name of NODE_NAMES) {
      expect(nodeKeys, `compiled graph should expose node "${name}"`).toContain(name);
    }
  });

  it('runs ingest -> respond against a stable fake model and returns its output — never a live call', async () => {
    const model = fakeModel('the fake model said this');
    const compiled = buildGraph(model);

    const result = await compiled.invoke({ input: '  what is the status of TRO-313?  ' });

    expect(model.invoke).toHaveBeenCalledTimes(1);
    // ingest trims before respond ever sees it
    expect(model.invoke).toHaveBeenCalledWith('what is the status of TRO-313?');
    expect(result.output).toBe('the fake model said this');
  });

  it('joins array-shaped model content (e.g. multi-block Anthropic responses) into a single string', async () => {
    const model: AnthropicModel = {
      invoke: vi.fn().mockResolvedValue({ content: ['part one ', 'part two'] }),
    };
    const compiled = buildGraph(model);

    const result = await compiled.invoke({ input: 'hello' });

    expect(result.output).toBe('part one part two');
  });

  it('extracts `.text` from a native Anthropic `{ type: "text", text }` block inside an array, rather than JSON.stringify-ing it', async () => {
    const model: AnthropicModel = {
      invoke: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'hello from a real content block' }],
      }),
    };
    const compiled = buildGraph(model);

    const result = await compiled.invoke({ input: 'hello' });

    expect(result.output).toBe('hello from a real content block');
  });

  it('extracts `.text` from a bare (non-array) native text block too', async () => {
    const model: AnthropicModel = {
      invoke: vi.fn().mockResolvedValue({ content: { type: 'text', text: 'top-level text block' } }),
    };
    const compiled = buildGraph(model);

    const result = await compiled.invoke({ input: 'hello' });

    expect(result.output).toBe('top-level text block');
  });

  it('propagates a model failure rather than swallowing it', async () => {
    const model: AnthropicModel = { invoke: vi.fn().mockRejectedValue(new Error('model unavailable')) };
    const compiled = buildGraph(model);

    await expect(compiled.invoke({ input: 'hello' })).rejects.toThrow('model unavailable');
  });
});
