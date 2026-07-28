/**
 * SSM Parameter Store - Application Configuration
 *
 * This file loads application configuration from AWS SSM Parameter Store.
 *
 * Secrets Storage:
 * ─────────────────
 * SSM Parameter Store (/ship/{env}/):
 *   - DATABASE_URL, SESSION_SECRET, CORS_ORIGIN
 *   - Application config that changes per environment
 *   - CAIA OAuth credentials (CAIA_ISSUER_URL, CAIA_CLIENT_ID, etc.)
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Lazy-initialized client to avoid keeping Node.js alive during import tests
let _client: SSMClient | null = null;

function getClient(): SSMClient {
  if (!_client) {
    _client = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return _client;
}

export async function getSSMSecret(name: string): Promise<string> {
  const command = new GetParameterCommand({
    Name: name,
    WithDecryption: true,
  });

  const response = await getClient().send(command);
  if (!response.Parameter?.Value) {
    throw new Error(`SSM parameter ${name} not found`);
  }
  return response.Parameter.Value;
}

export async function loadProductionSecrets(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    return; // Use .env files for local dev
  }

  const environment = process.env.ENVIRONMENT || 'prod';
  const basePath = `/ship/${environment}`;

  console.log(`Loading secrets from SSM path: ${basePath}`);

  try {
    const [databaseUrl, sessionSecret, corsOrigin, cdnDomain, appBaseUrl] = await Promise.all([
      getSSMSecret(`${basePath}/DATABASE_URL`),
      getSSMSecret(`${basePath}/SESSION_SECRET`),
      getSSMSecret(`${basePath}/CORS_ORIGIN`),
      getSSMSecret(`${basePath}/CDN_DOMAIN`),
      getSSMSecret(`${basePath}/APP_BASE_URL`),
    ]);

    process.env.DATABASE_URL = databaseUrl;
    process.env.SESSION_SECRET = sessionSecret;
    process.env.CORS_ORIGIN = corsOrigin;
    process.env.CDN_DOMAIN = cdnDomain;
    process.env.APP_BASE_URL = appBaseUrl;

    console.log('Secrets loaded from SSM Parameter Store');
    console.log(`CORS_ORIGIN: ${corsOrigin}`);
    console.log(`CDN_DOMAIN: ${cdnDomain}`);
    console.log(`APP_BASE_URL: ${appBaseUrl}`);
  } catch (err) {
    // SSM is the AWS delivery mechanism, not the only one. On a platform that
    // injects secrets as environment variables directly (Render, Fly, a plain
    // container), there are no AWS credentials and this call cannot succeed —
    // previously it threw and killed the process before the app ever started.
    //
    // Fall back only when the environment already supplies what SSM would have
    // provided, so a genuine AWS misconfiguration still fails loudly instead of
    // starting a server with no database.
    const message = err instanceof Error ? err.message : String(err);

    if (process.env.DATABASE_URL && process.env.SESSION_SECRET) {
      console.warn(
        `SSM unavailable (${message}) — continuing with secrets supplied by the environment.`
      );
      return;
    }

    console.error(
      `SSM unavailable (${message}) and neither DATABASE_URL nor SESSION_SECRET is set in the ` +
      `environment. Provide them directly, or grant this runtime read access to ${basePath}/*.`
    );
    throw err;
  }
}
