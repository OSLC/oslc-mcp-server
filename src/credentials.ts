import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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

/** Which OAuth grant obtains the token, and therefore whose identity it carries. */
export type OAuthGrant = 'password' | 'client_credentials' | 'authorization_code';

/** A server's OAuth configuration, with every reference resolved. */
export interface ResolvedOAuth {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /**
   * `password` yields a token representing {@link username} — the right
   * identity for a server acting on a user's behalf, and what a deployment's
   * access rules are written against. `client_credentials` yields a token
   * representing the client itself, with no user at all.
   */
  grant: OAuthGrant;
  /** The resource owner, for the password grant only. */
  username?: string;
  password?: string;
  /**
   * Loopback redirect for the authorization code grant. Must match one
   * registered on the OAuth client exactly.
   */
  redirectUri?: string;
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
/**
 * Read a secret held in a file of its own.
 *
 * Resolved against the configuration that named it rather than the working
 * directory, for the same reason the token store is: where a process happens to
 * be launched from must not decide whether it can authenticate.
 */
function readSecretFile(
  spec: string, baseDir: string, alias: string, field: string
): string {
  const path = spec.startsWith('~/')
    ? join(homedir(), spec.slice(2))
    : resolve(baseDir, spec);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(
      `Server \`${alias}\`: cannot read \`${field}\` ${path} — ${(e as Error).message}`
    );
  }

  // A file edited by hand ends in a newline, and a secret with a newline on it
  // fails authentication with a message about the credential rather than about
  // the whitespace.
  const value = raw.trim();
  if (!value) throw new Error(`Server \`${alias}\`: \`${field}\` ${path} is empty.`);

  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      console.error(
        `[config] ${alias}: ${path} is mode ${mode.toString(8)} — readable beyond its owner. ` +
        `chmod 600 it.`
      );
    }
  } catch { /* the read already succeeded; a failed stat is not worth failing over */ }

  return value;
}

export function resolveOAuth(
  server: ServerEntry,
  env: NodeJS.ProcessEnv,
  baseDir: string = process.cwd()
): ResolvedOAuth | null {
  const oauth = server.oauth;
  if (!oauth) return null;

  const missing: string[] = [];

  const clientId = oauth.clientIdEnv ? env[oauth.clientIdEnv] : oauth.clientId;
  if (oauth.clientIdEnv && !env[oauth.clientIdEnv]) missing.push(oauth.clientIdEnv);

  // An environment variable WINS WHEN SET, so a CI run can override the file
  // without editing it; the file is the fallback, and is the normal case on a
  // workstation. Only when neither yields a value is the variable reported
  // missing — naming a file and an unset variable is not an error.
  let clientSecret: string | undefined;
  if (oauth.clientSecretEnv && env[oauth.clientSecretEnv]) {
    clientSecret = env[oauth.clientSecretEnv];
  } else if (oauth.clientSecretFile) {
    clientSecret = readSecretFile(oauth.clientSecretFile, baseDir, server.alias, 'clientSecretFile');
  } else if (oauth.clientSecretEnv) {
    missing.push(oauth.clientSecretEnv);
  } else {
    clientSecret = oauth.clientSecret;
  }

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

  // Which grant, and therefore whose identity the token carries. The default
  // follows what the server actually has: a configured user means a token that
  // represents that user, which is almost always what was wanted — a service
  // principal sees what IT can see, not what the operator can see.
  const { username, password } = resolveCredentials(server, env);
  const hasUser = Boolean(username && password);

  const known: OAuthGrant[] = ['password', 'client_credentials', 'authorization_code'];
  if (oauth.grant !== undefined && !known.includes(oauth.grant as OAuthGrant)) {
    throw new Error(
      `Server \`${server.alias}\`: unknown oauth \`grant\` \`${oauth.grant}\` — ` +
      `use ${known.map(g => `\`${g}\``).join(', ')}.`
    );
  }
  const grant: OAuthGrant = oauth.grant ?? (hasUser ? 'password' : 'client_credentials');

  if (grant === 'authorization_code' && !oauth.redirectUri) {
    throw new Error(
      `Server \`${server.alias}\`: the \`authorization_code\` grant needs \`redirectUri\`, ` +
      `which must exactly match one registered on the OAuth client.`
    );
  }

  if (grant === 'password' && !hasUser) {
    throw new Error(
      `Server \`${server.alias}\`: the \`password\` grant needs \`credentials\` ` +
      `(usernameEnv/passwordEnv) naming the user the token should represent.`
    );
  }

  return {
    issuer: oauth.issuer,
    clientId,
    clientSecret,
    scope: oauth.scope,
    grant,
    // Carried only for the grant that uses them: neither a service-principal
    // token nor a browser sign-in should drag the user's password along.
    username: grant === 'password' ? username : undefined,
    password: grant === 'password' ? password : undefined,
    redirectUri: grant === 'authorization_code' ? oauth.redirectUri : undefined,
  };
}
