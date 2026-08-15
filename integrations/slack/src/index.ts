import { WebClient } from '@slack/web-api';
import { createApp } from './server.js';

/** The only place this package reads `process.env` — `server.ts`'s
 *  `createApp()` takes everything as injected options precisely so this is
 *  the one boundary, keeping the rest of the module graph testable without
 *  environment mutation. See README.md for what each var is and how to get
 *  it. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required — see integrations/slack/README.md's setup steps.`);
  }
  return value;
}

const port = Number(process.env.PORT ?? 3900);
const slackClient = new WebClient(requireEnv('SLACK_BOT_TOKEN'));

const app = createApp({
  webhookSecret: requireEnv('SHIP_WEBHOOK_SECRET'),
  slackClient,
  channel: requireEnv('SLACK_CHANNEL_ID'),
});

app.listen(port, () => {
  console.log(`[slack-integration] listening on :${port}, webhook route POST /webhooks/ship`);
});
