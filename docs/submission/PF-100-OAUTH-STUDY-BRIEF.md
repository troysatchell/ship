# PF-100 — OAuth Study Brief (🔔 HUMAN CHECKPOINT)

**For:** Troy · **Time to read:** ~30 minutes · **Purpose:** you will defend this material in a live interview, and your ack on this brief unblocks all of E1 (the critical path of Week 6).

**How to read it:** every concept lands twice — once as the standard says it, once as the exact Ship endpoint/table/ticket it becomes. If you can explain the right-hand column of each mapping table from memory, you're done.

---

## 1. The cast of characters (RFC 6749 roles)

OAuth 2.0 is a protocol for **delegation**: letting a third-party app act on a user's behalf without ever seeing the user's password.

| RFC 6749 role | Who it is in Ship |
|---|---|
| **Resource owner** | The human Ship user (e.g. alice.chen) |
| **Client** | The third-party app: the CLI, the browser demo, Slack integration, FleetGraph |
| **Authorization server** | Ship's new `/oauth/*` endpoints (PF-103/104/106) |
| **Resource server** | Ship's new public API `/api/v1/*` (E2), guarded by the bearer middleware (PF-107) |

The key mental shift: **the token replaces the password**, and it is *narrower* than the password in three ways — it's scoped (can only do what its scopes allow), it expires (1 hour), and it's revocable without changing the user's password.

**Confidential vs public clients** (this distinction drives everything below):
- A **confidential client** runs on a server and can keep a secret (our Slack integration, FleetGraph).
- A **public client** runs somewhere the user can inspect — a browser tab, a CLI on their laptop. **It cannot keep a secret**: anything shipped in JS or a binary can be extracted. The CLI and browser demo are public clients.

## 2. The two user-facing grants we implement (+ one app-only)

A "grant" is just a choreography for getting a token. The brief mandates two user-facing ones; we add a third app-only grant for the agent.

### 2.1 Authorization Code + PKCE (RFC 6749 §4.1 + RFC 7636) — the browser flow

The story (this is the graded Playwright e2e, PF-103 + PF-104):

1. App redirects the user's browser to `GET /oauth/authorize?client_id=…&redirect_uri=…&scope=…&code_challenge=…&code_challenge_method=S256`
2. Ship shows the **consent screen** (session-authed page in the web app — new minimal route, `frame-ancestors 'none'` so it can't be clickjacked inside an iframe)
3. User approves → Ship redirects back to the app's `redirect_uri` with a **single-use authorization code** (10-minute expiry)
4. The app's backend (or the SPA itself) POSTs the code to `/oauth/token` and receives `{ access_token, refresh_token, expires_in }`

Why the two-step dance (code first, then token)? The redirect travels through the **browser** (front channel) — URLs leak into history, logs, referrer headers. The code is worthless by itself; exchanging it happens server-to-server (back channel). A leaked code is (a) expired in 10 minutes, (b) single-use, and (c) — with PKCE — useless without the verifier.

**PKCE (RFC 7636), pronounced "pixy":** the fix for public clients that can't hold a `client_secret`.

- Before step 1, the app generates a random `code_verifier`, computes `code_challenge = BASE64URL(SHA256(code_verifier))`, and sends only the challenge.
- At step 4 it sends the original `code_verifier`. Ship recomputes the SHA-256 and compares against the stored challenge.
- **What S256 buys over sending a plain secret:** an attacker who intercepts the *authorization request* (the front channel, the leaky one) sees only the challenge — a hash. They cannot invert it to produce the verifier, so an intercepted code is still unredeemable. `method=plain` (verifier sent as its own challenge) would make the interceptor's life trivial — which is why **Ship rejects everything except S256** (PF-103) and why the brief calls "no plain PKCE" out by name.
- Why not just give the SPA a `client_secret`? Because a secret embedded in browser JS is public by definition. PKCE gives each *authorization attempt* its own throwaway secret that never travels the leaky channel.

**The negative cases are mandatory and graded** (PF-104): wrong verifier → `400 invalid_grant`; **reused code → `invalid_grant` AND every token already issued from that code is revoked** (a reused code means someone replayed it — assume theft); wrong `redirect_uri` → `invalid_grant` (exact string match against the registered list — no wildcards, no prefix matching, or an attacker registers `evil.com` lookalikes).

### 2.2 Device Authorization Grant (RFC 8628) — the CLI flow

For clients with **no browser and no keyboard-friendly redirect**: our CLI (`ship login`, PF-600), TVs, IoT.

1. CLI calls `POST /oauth/device/code` → gets `{ device_code, user_code, verification_uri, interval }`
2. CLI displays: *"Go to ship.example/oauth/device/verify and enter **BDWJ-KXQT**"*
3. User does that in any browser where they're already logged in, approves
4. Meanwhile the CLI **polls** `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` every `interval` seconds

The poll answers (this is the part interviews love):
- `authorization_pending` — user hasn't approved yet, keep polling
- **`slow_down`** — you're polling too fast; **add 5 seconds to your interval** (RFC 8628 §3.5). Ship *honors* this server-side: a client that keeps hammering keeps getting `slow_down`, and the graded test asserts the interval actually increases (PF-106).
- `expired_token` — user never approved within the window; start over
- success → tokens

**user_code UX** (why `BDWJ-KXQT` and not a UUID): the human has to *transcribe* it across devices — from terminal to phone. So: short, grouped, uppercase, drawn from a charset with no ambiguous glyphs (no 0/O, no 1/I). The device_code (long, high-entropy) never touches human eyes; the user_code (low-entropy, human-friendly) is safe *because* it's single-use, short-lived, and rate-limited server-side.

### 2.3 Client Credentials (RFC 6749 §4.4) — the app-only grant

No user at all: the app authenticates as **itself** with `client_id` + `client_secret` and gets a token with `user_id = null`. This is how **FleetGraph reads** in Epic 7 (`ship_app_fleetgraph`, read-only scopes) — the agent's reads belong to the *app*, its writes still happen with the *acting human's* token (the hybrid identity decided in §1.4.4). Only confidential clients get this grant — it *is* a secret-holder's flow.

## 3. Refresh rotation + family invalidation — the stolen-token story

Access tokens live 1 hour. Refresh tokens live 30 days but are **one-time-use**:

- Using refresh token R1 issues access token A2 **and a new refresh token R2**, recorded as R1's child in the same `family_id`. R1 is now dead.
- **If anyone ever presents R1 again, Ship revokes the entire family** — every descendant, including whatever R2/R3/R4 chain exists, killing all live sessions from that grant.

Why this specific rule: if R1 is presented twice, one of the two presenters is a thief — and you *cannot tell which*. The legitimate client and the thief both hold plausible chains. The only safe move is to burn the whole family and force a fresh login. This converts token theft from "silent 30-day compromise" into "everyone gets logged out and the theft is *detectable* in the logs." That detectability is the whole point — it's PF-800's narrated e2e ("the stolen-token story") and a near-certain interview question.

## 4. Concept → Ship implementation map (memorize this table)

| Concept | Ship endpoint / table / ticket |
|---|---|
| App registration, `client_id`/`client_secret` | `oauth_apps` (migration 042), secret SHA-256 at rest, shown once — PF-102 |
| Authorization request + consent | `GET /oauth/authorize` + web consent page — PF-103 |
| Authorization code (single-use, 10 min, hashed) | `oauth_authorization_codes` (043) — PF-103 |
| Code → token exchange, PKCE verify, client_credentials | `POST /oauth/token` — PF-104 |
| Access/refresh tokens, `family_id`/`parent_id` chain | `oauth_tokens` (043), hashes only, `user_id` nullable for CC — PF-104/105 |
| Rotation + family revocation | token service — PF-105 (engine for PF-800) |
| Device codes, user_code, pending/approved states | `oauth_device_codes` (043) + `/oauth/device/*` — PF-106 |
| Scopes as data, `require(scope)`, two token classes | ScopeRegistry + bearer middleware — PF-107; scoped personal tokens = `api_tokens.scopes` (043) |
| TTLs | access 1 h · refresh 30 d, one-time-use · codes 10 min |

**Why every credential is stored as a hash (or not at all):** a DB dump must not yield usable tokens. We store SHA-256 of tokens/codes/secrets and compare hashes at lookup — same pattern as Ship's existing `api_tokens`. (The one deliberate exception in Week 6 is *webhook signing secrets*, which must be **possessed** to compute HMACs — those are AES-256-GCM encrypted, not hashed, and that's a documented deviation you should be able to defend: §2.2 note, Stripe does the equivalent.)

## 5. Likely interview questions (with the one-breath answers)

1. **"Why PKCE instead of a client secret for the CLI/SPA?"** Public clients can't keep secrets — anything in shipped JS/binaries is extractable. PKCE gives each auth attempt a one-shot secret whose hash-only form travels the leaky front channel.
2. **"Why S256 only, no `plain`?"** `plain` sends the verifier as the challenge — an interceptor of the authorization request replays it directly. S256 makes the intercepted value non-invertible.
3. **"What happens if an authorization code is used twice?"** `invalid_grant`, plus revocation of all tokens issued from that code — double redemption implies replay/theft.
4. **"Why rotate refresh tokens at all?"** One-time-use makes theft *detectable*: the second presentation of a spent token is proof of compromise, and family revocation contains it.
5. **"Why does `slow_down` exist and what must a client do?"** Device-flow polling is unauthenticated load; `slow_down` is back-pressure. The client must add 5 s to its interval permanently — and Ship enforces it, not just suggests it.
6. **"Why is the exact redirect_uri match important?"** The redirect is where the code lands. Any looseness (prefix/wildcard) lets an attacker receive codes at a URI the app owner never registered.
7. **"Why does the agent use client_credentials for reads but human tokens for writes?"** Reads are the app's own function (drafting context); writes are actions *on a human's authority* — the audit trail must attribute them to the person who accepted, and it does (PF-704's proof).
8. **"Where do scopes get enforced?"** Never in handlers — `require(scope)` middleware backed by a data registry (OCP: adding a scope registers data, edits no middleware). 403s name the missing scope in `details.missing_scope`.
9. **"What's in a `Ship-Signature` header and why the timestamp?"** *(webhooks, adjacent but expect it)* `t=<unix>,v1=<hmac>` over `${t}.${rawBody}` — the timestamp bounds replay to a 300 s window.

## 6. What we deliberately did NOT build (say these out loud if asked)

- **No implicit grant** — deprecated (tokens in URL fragments leak); auth-code+PKCE replaced it industry-wide.
- **No `plain` PKCE** — see Q2.
- **No password grant** — the entire point of OAuth is that apps never see passwords.
- **Hand-rolled, IETF-minimal** (RFC 6749 + 7636 + 8628) rather than a library — decided with you (§1.4.5); the surface is small enough to own and defend line-by-line, and the negative tests are the proof of correctness.

---

**To unblock E1:** reply "ack" in the session or comment "ack" on the PF-100 Linear ticket. E0 (scaffold/errors/lint/limiter), E9 Day-1 items (terraform, IAM memo, architecture doc), and all non-E1 preparation continue in parallel regardless.
