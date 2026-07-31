import { describe, it, expect } from 'vitest';
import { computeICEScore, DEFAULT_PROJECT_PROPERTIES } from './document.js';

describe('computeICEScore', () => {
  it('multiplies impact, confidence, and ease when all are set', () => {
    expect(computeICEScore(3, 4, 2)).toBe(24);
  });

  it('returns the minimum possible score at the floor of the 1-5 scale', () => {
    expect(computeICEScore(1, 1, 1)).toBe(1);
  });

  it('returns the maximum possible score at the ceiling of the 1-5 scale', () => {
    expect(computeICEScore(5, 5, 5)).toBe(125);
  });

  it('returns null when impact is unset', () => {
    expect(computeICEScore(null, 4, 2)).toBeNull();
  });

  it('returns null when confidence is unset', () => {
    expect(computeICEScore(3, null, 2)).toBeNull();
  });

  it('returns null when ease is unset', () => {
    expect(computeICEScore(3, 4, null)).toBeNull();
  });

  it('returns null when every value is unset', () => {
    expect(computeICEScore(null, null, null)).toBeNull();
  });

  it('does not treat zero as unset (only null short-circuits)', () => {
    // 0 is not a valid ICEScore (1-5), but the function's own null-check should
    // only special-case null, not any falsy value — a `if (!impact)` bug would
    // wrongly return null here instead of 0.
    expect(computeICEScore(0, 4, 2)).toBe(0);
  });
});

describe('DEFAULT_PROJECT_PROPERTIES', () => {
  it('starts all three ICE inputs unset so no score is implied at creation', () => {
    expect(DEFAULT_PROJECT_PROPERTIES.impact).toBeNull();
    expect(DEFAULT_PROJECT_PROPERTIES.confidence).toBeNull();
    expect(DEFAULT_PROJECT_PROPERTIES.ease).toBeNull();
  });

  it('computes to an unset ICE score by construction', () => {
    const { impact, confidence, ease } = DEFAULT_PROJECT_PROPERTIES;
    expect(computeICEScore(impact ?? null, confidence ?? null, ease ?? null)).toBeNull();
  });

  it('starts with no assigned owner', () => {
    expect(DEFAULT_PROJECT_PROPERTIES.owner_id).toBeNull();
  });

  it('provides a default color value', () => {
    expect(DEFAULT_PROJECT_PROPERTIES.color).toBe('#6366f1');
  });
});
