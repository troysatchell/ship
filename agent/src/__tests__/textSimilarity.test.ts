import { describe, expect, it } from 'vitest';
import { computeTextSimilarity } from '../textSimilarity.js';

describe('computeTextSimilarity', () => {
  it('scores identical text as 1', () => {
    expect(computeTextSimilarity('Moved the issue to review.', 'Moved the issue to review.')).toBe(1);
  });

  it('is case-insensitive and punctuation-insensitive', () => {
    expect(computeTextSimilarity('Moved "Build issue assignment flow" to review.', 'moved build issue assignment flow to review'))
      .toBe(1);
  });

  it('scores completely disjoint text as 0', () => {
    expect(computeTextSimilarity('apples oranges bananas', 'quarterly revenue projections increased')).toBe(0);
  });

  it('scores partial overlap strictly between 0 and 1', () => {
    const score = computeTextSimilarity(
      'Moved "Build issue assignment flow" to In Review.',
      'I moved the assignment flow issue into review status today.'
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('two empty strings are treated as identical (nothing to disagree about)', () => {
    expect(computeTextSimilarity('', '')).toBe(1);
  });

  it('one empty and one non-empty string is maximally dissimilar, never NaN', () => {
    const score = computeTextSimilarity('', 'Moved the issue to review.');
    expect(score).toBe(0);
    expect(Number.isNaN(score)).toBe(false);
  });

  it('drops short function words so shared glue words do not inflate the score', () => {
    // "I" / "to" / "on" / "a" are all below MIN_TOKEN_LENGTH — two drafts that
    // share ONLY function words and no real content should score 0, not a
    // false-positive partial match from "to"/"a" appearing in both.
    const score = computeTextSimilarity('I go to a review on it', 'I am to a call on this');
    expect(score).toBe(0);
  });

  it('a superset of the reference text scores higher than a near-total rewrite', () => {
    const reference = 'Moved "Build issue assignment flow" to In Review after finishing the implementation.';
    const editedLightly = 'Moved "Build issue assignment flow" to In Review after finishing the implementation. Also fixed a typo.';
    const rewrittenFromScratch = 'Quiet day, mostly attended meetings and reviewed unrelated documentation.';

    const lightEditScore = computeTextSimilarity(editedLightly, reference);
    const rewriteScore = computeTextSimilarity(rewrittenFromScratch, reference);

    expect(lightEditScore).toBeGreaterThan(rewriteScore);
  });
});
