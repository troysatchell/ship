#!/usr/bin/env node
/**
 * notify.mjs — the factory's only channel to the human.
 *
 * The factory is a closed loop: findings become tickets, tickets get fixed,
 * fixes get verified, verified work self-closes. A human sees none of that.
 * This script is what breaks the loop open when it genuinely needs a person.
 *
 * That framing is the whole design constraint. Every message sent here costs
 * attention, and attention spent on a notification that did not need sending
 * is what trains someone to stop reading them. Send on the triggers in
 * references/escalation.md and the wave summary. Nothing else.
 *
 * Setup (one time):
 *   1. Create a Slack incoming webhook: https://api.slack.com/messaging/webhooks
 *   2. export SLACK_WEBHOOK_URL='https://hooks.slack.com/services/...'
 *
 * The URL embeds its own secret in the path, so it is a credential. Keep it in
 * the environment — never in a committed file. The pre-commit compliance scan
 * will catch it, but do not rely on that.
 *
 * Degrades rather than blocks: with no webhook configured it prints to stdout
 * and exits 0. A notification failure must never fail a factory run.
 *
 * Usage:
 *   node scripts/factory/notify.mjs \
 *     --severity blocked \
 *     --ticket TRO-311 \
 *     --title "Three failed gates" \
 *     --why "Regression test passes standalone but fails in suite; suspect test isolation" \
 *     --need "Decide whether to quarantine or keep digging" \
 *     --link https://github.com/troysatchell/ship/pull/42
 *
 *   node scripts/factory/notify.mjs --severity wave --title "Wave 3 complete" \
 *     --why "4 merged, 1 blocked" --link http://localhost:7373
 */

/**
 * THE ONLY TEST FOR SENDING ANYTHING:
 *
 *   Is the factory stopped until this person answers?
 *
 * If it can keep going, it does not go here. Progress, successes, wave counts,
 * findings the PM already dismissed, a first or second failed gate inside the
 * retry budget — all of that is pull, not push. The board at localhost:7373
 * already answers "how is it going" for free and without costing anyone's
 * attention.
 *
 * There is deliberately no severity for "informational". Adding one is how this
 * channel stops being read.
 */
const SEVERITY = {
  // A ticket is stopped and the factory has exhausted what it can decide alone.
  blocked: { emoji: ':octagonal_sign:', color: '#9A4B12', label: 'BLOCKED — needs a decision' },
  // A human gate from references/escalation.md: credentials, an irreversible or
  // outward-facing action, product-visible behaviour, auth/session semantics.
  gate:    { emoji: ':lock:',           color: '#9A4B12', label: 'HUMAN GATE — cannot proceed' },
  // End of an unattended run that finished with unresolved items. Requires
  // --count > 0; a clean run sends nothing at all.
  summary: { emoji: ':clipboard:',      color: '#B8860B', label: 'RUN ENDED — items need you' },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? (i += 1, next) : 'true';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const severity = args.severity || 'blocked';
const meta = SEVERITY[severity];

if (!meta) {
  console.error(`unknown --severity "${severity}". one of: ${Object.keys(SEVERITY).join(', ')}`);
  process.exit(2);
}
if (!args.title) {
  console.error('--title is required');
  process.exit(2);
}

// A clean run is silence. `--severity summary --count 0` is not a message worth
// anyone's attention, so it is refused rather than sent — the guard lives here
// and not in a caller's discipline, because every caller eventually forgets.
if (severity === 'summary') {
  const count = Number.parseInt(args.count ?? '', 10);
  if (!Number.isFinite(count)) {
    console.error('--severity summary requires --count <number of items needing a human>');
    process.exit(2);
  }
  if (count <= 0) {
    console.log('run ended clean — nothing needs a human, so nothing sent');
    process.exit(0);
  }
}

const lines = [
  `${meta.emoji}  *${meta.label}*`,
  args.ticket ? `*${args.ticket}* — ${args.title}` : `*${args.title}*`,
  args.why  ? `\n${args.why}` : '',
  args.need ? `\n*Needs from you:* ${args.need}` : '',
  args.link ? `\n${args.link}` : '',
].filter(Boolean);

const text = lines.join('\n');

const webhook = process.env.SLACK_WEBHOOK_URL;

if (!webhook) {
  // No channel configured. Print and succeed — the factory keeps running, and
  // the operator still sees this in the run log.
  console.log('\n' + '─'.repeat(64));
  console.log(text.replace(/\*/g, ''));
  console.log('─'.repeat(64));
  console.log('(SLACK_WEBHOOK_URL unset — printed locally instead)\n');
  process.exit(0);
}

const payload = {
  text: `${meta.label}: ${args.title}`, // fallback for notifications//mobile
  attachments: [{
    color: meta.color,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  }],
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10_000);

try {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  if (!res.ok) {
    console.error(`slack responded ${res.status}: ${await res.text().catch(() => '')}`);
    console.error(text.replace(/\*/g, ''));
    process.exit(0); // still non-fatal
  }
  console.log(`notified: ${args.ticket ? args.ticket + ' — ' : ''}${args.title}`);
} catch (err) {
  // Timeout, DNS, offline — all non-fatal. Print so nothing is lost.
  console.error(`slack notify failed (${err.name}): falling back to stdout`);
  console.error(text.replace(/\*/g, ''));
  process.exit(0);
} finally {
  clearTimeout(timer);
}
