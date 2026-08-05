import { describe, expect, it } from 'vitest';
import { contentToString, parseThreshold } from '../scripts/golden-set-compare.js';

describe('parseThreshold', () => {
  it('defaults to 0.25 when --threshold is not passed', () => {
    expect(parseThreshold([])).toBe(0.25);
  });

  it('parses an explicit --threshold', () => {
    expect(parseThreshold(['--threshold', '0.4'])).toBe(0.4);
  });

  it('rejects a threshold outside [0, 1]', () => {
    expect(() => parseThreshold(['--threshold', '1.5'])).toThrow(/between 0 and 1/);
    expect(() => parseThreshold(['--threshold', '-0.1'])).toThrow(/between 0 and 1/);
  });

  it('rejects a non-numeric threshold', () => {
    expect(() => parseThreshold(['--threshold', 'high'])).toThrow(/between 0 and 1/);
  });
});

describe('contentToString', () => {
  it('passes a plain string through unchanged', () => {
    expect(contentToString('hello')).toBe('hello');
  });

  it('extracts text from an array of Anthropic-shaped content blocks', () => {
    expect(contentToString([{ type: 'text', text: 'part one' }, { type: 'text', text: ' part two' }]))
      .toBe('part one part two');
  });

  it('stringifies an unrecognized shape rather than throwing', () => {
    expect(contentToString(42)).toBe('42');
  });
});
