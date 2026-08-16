# W6 social assets (TRO-444 / PF-908)

- `five-line-story-transcript.txt` — verbatim stdout of the real `@ship/cli` (`ship login`,
  `ship whoami`, `ship webhooks tail`, `ship docs create`) against a real API process in worktree
  `Ship-wt-tro_444`, commit `b68da413`, 2026-08-16. One hand edit, marked in the file header.
- `webhooks-tail-verified.txt` — the tail pane only (the `✓ verified … document.created` line).
- `webhooks-tail-verified.png` — that text rendered to a drawn terminal window with
  `render-terminal.mjs` (Playwright, 2× scale). **Not a photo or a real terminal screenshot**; the
  lines are real, the chrome is not. Force-added despite the repo's `*.png` ignore rule because it
  is the deliverable itself. Regenerate:
  `node docs/submission/social-assets/w6/render-terminal.mjs docs/submission/social-assets/w6/webhooks-tail-verified.txt docs/submission/social-assets/w6/webhooks-tail-verified.png "ship webhooks tail — Ship @ 127.0.0.1:3376"`

Post text: `../../PLUGFORGE-SOCIAL-POST.md`. Script: `../../PLUGFORGE-DEMO-SCRIPT.md`.
