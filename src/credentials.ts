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
