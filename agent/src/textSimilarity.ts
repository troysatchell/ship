/**
 * Shared text-similarity scorer (TRO-338 / FG-20).
 *
 * One deterministic, dependency-free function, used for two different
 * comparisons this ticket needs:
 *  - `goldenSet.ts`: how far a model's actual output has moved from a
 *    human-written reference draft, for the SAME real activity state.
 *  - `draftSurvival.ts`: how much of a posted draft survived unedited from
 *    the version the agent originally composed.
 *
 * Both questions are the same underlying one — "how similar is text A to
 * text B" — so one scorer answers both rather than inventing two metrics
 * that could quietly drift apart.
 *
 * Deliberately simple: case-insensitive, punctuation-stripped Jaccard
 * similarity over word tokens (intersection / union). This is NOT a claim
 * of semantic understanding — a paraphrase that keeps every real fact
 * (issue titles, day counts) scores reasonably well; a draft with no real
 * facts to draw from (the "boots but broken" case for context assembly:
 * activity data silently came back empty) shares almost no tokens with a
 * reference that DOES name specifics, and scores low. That is exactly the
 * failure mode this ticket needs to catch — see `goldenSet.test.ts`'s own
 * proof.
 */

const MIN_TOKEN_LENGTH = 3;

/** Lowercases, strips punctuation, and splits on whitespace — tokens under
 * `MIN_TOKEN_LENGTH` (mostly function words: "a", "to", "on", "is") are
 * dropped so the score reflects content words, not sentence glue every
 * draft shares regardless of what it actually says. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= MIN_TOKEN_LENGTH)
  );
}

/**
 * Jaccard similarity (|intersection| / |union|) over each text's token set,
 * in `[0, 1]`. Two texts with no content tokens at all (e.g. both empty)
 * are treated as identical (`1`) — there is no disagreement to measure.
 * One empty and one non-empty text scores `0` — maximally dissimilar, not
 * `NaN` from a division by zero.
 */
export function computeTextSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersectionSize++;
  }
  const unionSize = new Set([...tokensA, ...tokensB]).size;

  return intersectionSize / unionSize;
}
