import type { ServerEntry } from './config-file.js';

/**
 * Resolve a server's credentials.
 *
 * Environment references win over literals when a configuration carries
 * both, so an operator can override a checked-out literal without editing
 * the file. Errors name the server and the missing variable — never a
 * value, since these errors are logged.
 */
export function resolveCredentials(
  server: ServerEntry,
  env: NodeJS.ProcessEnv
): { username: string; password: string } {
  const creds = server.credentials;
  if (!creds) {
    return { username: '', password: '' };
  }

  if (creds.usernameEnv && creds.passwordEnv) {
    const username = env[creds.usernameEnv];
    const password = env[creds.passwordEnv];

    const missing: string[] = [];
    if (!username) missing.push(creds.usernameEnv);
    if (!password) missing.push(creds.passwordEnv);
    if (missing.length > 0) {
      throw new Error(
        `Server \`${server.alias}\`: environment variable(s) not set: ${missing.join(', ')}.`
      );
    }

    return { username: username!, password: password! };
  }

  return { username: creds.username ?? '', password: creds.password ?? '' };
}

/** A server's OAuth client credentials, with every reference resolved. */
export interface ResolvedOAuth {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

/**
 * Resolve a server's OAuth client credentials, or null when it configures none.
 *
 * Mirrors {@link resolveCredentials}: environment references win over literals,
 * so an operator can override a checked-out literal without editing the file,
 * and errors name the server and the missing variable — never a value, since
 * these errors are logged.
 *
 * A named-but-unset environment variable is an error rather than a silent fall
 * back to the literal: naming the variable is the operator saying where the
 * value comes from, and quietly using a different source is how a stale
 * credential survives a rotation.
 */
export function resolveOAuth(
  server: ServerEntry,
  env: NodeJS.ProcessEnv
): ResolvedOAuth | null {
  const oauth = server.oauth;
  if (!oauth) return null;

  const missing: string[] = [];

  const clientId = oauth.clientIdEnv ? env[oauth.clientIdEnv] : oauth.clientId;
  if (oauth.clientIdEnv && !env[oauth.clientIdEnv]) missing.push(oauth.clientIdEnv);

  const clientSecret = oauth.clientSecretEnv ? env[oauth.clientSecretEnv] : oauth.clientSecret;
  if (oauth.clientSecretEnv && !env[oauth.clientSecretEnv]) missing.push(oauth.clientSecretEnv);

  if (missing.length > 0) {
    throw new Error(
      `Server \`${server.alias}\`: environment variable(s) not set: ${missing.join(', ')}.`
    );
  }
  if (!clientId || !clientSecret) {
    throw new Error(
      `Server \`${server.alias}\`: \`oauth\` requires a client id and secret.`
    );
  }

  return { issuer: oauth.issuer, clientId, clientSecret, scope: oauth.scope };
}
