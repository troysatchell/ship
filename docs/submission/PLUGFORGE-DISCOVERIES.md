# PlugForge — Three Discoveries

PF-906 (TRO-437). Three technical write-ups drafted from the PRD's four candidate topics
(Device Grant in TypeScript, zod→OpenAPI fitness parity, Stripe-style HMAC anti-replay,
async-iterator pagination DX) — these three chosen because each has a genuinely specific,
file-cited story behind it, not just a correct implementation of a known pattern. Claims are marked
**Observed** (read directly, cited by path) or **Derived** (reasoning from an observed fact), per
`.claude/CLAUDE.md`'s provenance rule.

This is a distinct, new, W6-specific document — not a revision of `docs/submission/DISCOVERY.md`,
which is a leftover Week-4 document on an unrelated subject (dev-workflow discoveries from the
original audit sprint) and is left untouched.

---

## Discovery: OAuth Device Authorization Grant in TypeScript

RFC 8628 is short on code and long on state-machine subtlety, and the subtlety mostly lives in one
question: what does the server actually have to *remember* between polls?

**Observed:** the human-typable `user_code` (`generateUserCode()`, `api/src/platform/oauth/device.ts:131-136`)
is an 8-character code from a restricted alphabet, formatted `XXXX-XXXX` — e.g. `BDWJ-KXQT`, the
PRD's own example. A sibling function, `normalizeUserCode()` (`:145-152`), uppercases the input,
strips everything but alphabet characters, and re-inserts the canonical hyphen — so a user who
types lowercase, forgets the hyphen, or pastes a code with stray whitespace still matches what's
stored. It returns `null` rather than a best-effort guess when normalization can't produce exactly
8 valid characters, which matters: callers treat `null` as "unknown code" instead of querying with
a value that could never legitimately match, closing off a timing or enumeration surface a looser
implementation might leave open.

The `device_code` — the long-lived secret the *polling client* holds, never typed by a human — is a
different shape entirely: 32 random bytes, hex, unprefixed (`generateDeviceCode()`, `:158-160`),
same entropy class as an authorization code. It's hashed before storage
(`hashDeviceCode()` → `hashToken()`). The `user_code`, notably, is **not** — `device.ts:212-214`
inserts it in plaintext alongside the hashed `device_code_hash` in the same `INSERT`. This is a
real, disclosed asymmetry, not a hidden one: a human types the `user_code` into a browser page it
already trusts (the verification URL), so its threat model is closer to a short-lived PIN than a
bearer credential — but it's still a genuine, currently-open follow-up finding (Backlog), and this
essay is not going to pretend otherwise just because the asymmetry is defensible.

The more interesting engineering detail is `slow_down` (RFC 8628 §3.5), because it's easy to
implement as a client-trust convention and hard to implement as something the server actually
enforces. **Observed:** `device.ts:40-54`'s own header states the design directly — a poll that
arrives before `interval_seconds` has elapsed since the last poll gets `slow_down` *and* has
`oauth_device_codes.interval_seconds` incremented server-side by the RFC's mandated 5 seconds
(`DEFAULT_DEVICE_POLL_INTERVAL_SECONDS` at line 102 cites "MUST use 5 as the default" directly from
the spec text). The next poll is checked against this new, larger interval, not the original one.
The consequence: a well-behaved client that already increased its own local interval on receiving
`slow_down` would never trigger a second increase — but a client that *ignores* the signal and
keeps polling at its original rate gets progressively throttled instead of stuck violating the same
fixed interval forever. That's the difference between "the client is supposed to slow down" and
"the client cannot avoid slowing down," and it lives entirely in one integer column that most
Device Grant tutorials never mention needs to persist across requests at all.

---

## Discovery: Zod-Driven OpenAPI with Bidirectional Fitness-Test Parity

The pattern itself — zod schemas as the single source of truth, generating an OpenAPI document
from route metadata in-process — isn't new. What's worth writing up is what happens when you take
that pattern and apply it *twice*, in two directions, as two separate CI-enforced fitness tests,
and what that buys you that a single generator step doesn't.

**Observed, direction one:** `api/src/platform/api/v1/__tests__/route-fitness.test.ts:275` walks
the live, mounted router stack and asserts, per route, five independently-checkable properties as
five separate `it(...)` blocks rather than one combined assertion — a real OpenAPI entry with
security metadata matching actual `bearerAuth` presence; a declared scope or a documented
exemption; the exact §2.5 `ApiError` shape on the generic failure path; `{data, next_cursor}`
pagination on list routes; and `X-RateLimit-*` headers. That last check was added later than the
first four, by a different ticket (PF-500) — and it was added as a sixth `it(...)` block onto the
*same* walk, not a parallel test file (the code's own comment states this is the intended extension
pattern). A route that skips OpenAPI registration, or forgets a scope, fails this walk — and
therefore fails CI. Documentation drift stops being a class of bug this codebase can *have*.

**Observed, direction two, "one layer over":** `sdk/src/__tests__/parity.test.ts`'s own header
names `route-fitness.test.ts` as its explicit precedent — "same discipline, one layer over" — and
checks OpenAPI ↔ SDK instead of routes ↔ OpenAPI: every registered operation needs a corresponding
typed SDK method, and every SDK method needs to correspond to a real operation, checked in both
directions so an orphaned SDK method is caught exactly as reliably as a missing one. The mapping
rule is stated explicitly rather than hand-waved — "every own (non-inherited, non-constructor)
instance method on `ShipClient.prototype` plus every resource client's prototype" counts as an SDK
method — which is precisely the kind of precision a fitness test needs to be trustworthy instead of
just reassuring.

The trade-off this second gate exists specifically to cover is named openly in the PRD itself: the
SDK is hand-written, not generated, for better type ergonomics — and a hand-written client is
exactly the kind of thing that silently drifts from its source of truth over time, because nothing
mechanically forces it to stay in sync the way a codegen step would. The fitness test is the
compensating control for a deliberately-chosen trade-off, not a belt-and-suspenders afterthought —
worth being explicit about in an interview, because "why isn't the SDK generated" is a fair
question and "type quality over generated drift-safety, and we built the CI check that makes the
trade-off safe" is a real, specific answer rather than a shrug.

---

## Discovery: Stripe-Style HMAC Signing and the Encrypt-Not-Hash Trade-off

Every other secret in this codebase is hashed at rest — passwords, API tokens, OAuth client
secrets. Webhook signing secrets are the one deliberate exception, and the reason is structural,
not a lapse in the "always hash" habit: the server has to *compute* an HMAC on every single
delivery, which requires the plaintext key. A one-way hash is unimplementable here by definition,
not by oversight — you cannot compute `HMAC-SHA256(secret, payload)` from a hash of `secret`.

**Observed:** the signature scheme is `Ship-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>` over
`${t}.${rawBody}` (`api/src/platform/webhooks/signer.ts`), and the comparison is genuinely
constant-time — the file imports `timingSafeEqual` from Node's real `node:crypto` module rather
than a hand-rolled byte-loop, which matters because a hand-rolled comparison is exactly where a
"constant-time" claim quietly stops being true under compiler optimization. The tolerance window
(default 300 seconds) is real and bounded, guarding against the signature-replay attack the
timestamp exists to prevent in the first place.

**Observed, the actual secret storage:** `api/src/platform/webhooks/secretEncryption.ts` uses
`ALGORITHM = 'aes-256-gcm'` via Node's real `createCipheriv`/`createDecipheriv` — not a comment
claiming AES-256-GCM while doing something weaker. The plaintext secret carries a real,
recognizable prefix (`WEBHOOK_SECRET_PREFIX = 'whsec_'`, matching Stripe's own convention for the
exact same reason: a secret that looks like what it is is easier to catch in a leaked log or a
committed `.env` file), shown exactly once at creation or rotation, and never again.

**The genuinely interesting bug this design surfaced, not a hypothetical one:** GCM's authenticated
encryption means a corrupted or tampered ciphertext fails to *decrypt* — it throws, the same way a
literally malformed blob would. The naive handling is to treat any decrypt failure as "this
delivery is broken, dead-letter it." But a `SECRET_ENCRYPTION_KEY` rotation produces *exactly* that
failure shape for every in-flight delivery signed under the old key, for a legitimate,
routine operational reason — and dead-lettering all of them would silently and permanently drop
every delivery in flight at the moment of rotation. **Observed:** `secretEncryption.ts:79` defines
a dedicated `MalformedCiphertextError` class, and `deliverer.ts:648,670` branches on
`instanceof MalformedCiphertextError` specifically — a *malformed* blob dead-letters immediately
(there's nothing to retry), but a GCM auth-tag mismatch that isn't a `MalformedCiphertextError` is
treated as **transient**: the delivery backs off and is left `pending` for a later
rehydrate, rather than being killed. One exception class, doing the job of distinguishing "this
will never work" from "this won't work *right now*, and that's expected during key rotation" —
found and fixed as part of building the retry ladder, not bolted on afterward.

This is the same shape of trade-off Stripe itself makes publicly, and naming that precedent is a
legitimate part of the defense: a well-known, production system made the identical call for the
identical structural reason, which is a stronger answer to "why not hash it like everything else"
than re-deriving the argument from scratch in the room.
