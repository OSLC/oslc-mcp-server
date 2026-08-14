import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/** One service provider (an ELM project area) to scope discovery to. */
export interface ServiceProviderEntry {
  uri: string;
  alias?: string;
  configurationContext?: string;
}

/**
 * How a server's credentials are supplied: either references to environment
 * variables (preferred) or literal values (accepted, warned about once).
 */
export interface CredentialsSpec {
  usernameEnv?: string;
  passwordEnv?: string;
  username?: string;
  password?: string;
}

/** One OSLC server. An ELM deployment needs one entry per application. */
export interface ServerEntry {
  alias: string;
  baseUrl: string;
  catalogUrl?: string;
  configurationContext?: string;
  credentials?: CredentialsSpec;
  serviceProviders?: ServiceProviderEntry[];
}

export interface ConfigFile {
  servers: ServerEntry[];
}

/**
 * Parse and validate configuration YAML.
 *
 * Credentials may be environment-variable references (`usernameEnv` /
 * `passwordEnv`, preferred) or literal values (`username` / `password`,
 * accepted with one warning). The configuration file is git-ignored, so a
 * literal is a reasonable local convenience — but it still travels in
 * pastes, backups and screen shares, which is what the warning is for.
 */
export function parseConfigFile(yamlText: string): ConfigFile {
  const raw = parseYaml(yamlText) as unknown;

  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).servers)) {
    throw new Error('Configuration must have a top-level `servers` list.');
  }

  const servers = (raw as any).servers as unknown[];
  if (servers.length === 0) {
    throw new Error('Configuration must define at least one server.');
  }

  const seen = new Set<string>();
  const parsed: ServerEntry[] = servers.map((entry, i) => {
    const s = (entry ?? {}) as Record<string, unknown>;
    const where = `servers[${i}]`;

    const alias = s.alias;
    if (typeof alias !== 'string' || alias.length === 0) {
      throw new Error(`${where}: every server needs a non-empty \`alias\`.`);
    }
    if (seen.has(alias)) {
      throw new Error(`${where}: duplicate server alias \`${alias}\`.`);
    }
    seen.add(alias);

    const baseUrl = s.baseUrl;
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      throw new Error(`Server \`${alias}\`: \`baseUrl\` is required.`);
    }

    let credentials: CredentialsSpec | undefined;
    if (s.credentials !== undefined) {
      const c = (s.credentials ?? {}) as Record<string, unknown>;
      const hasEnvPair =
        typeof c.usernameEnv === 'string' && typeof c.passwordEnv === 'string';
      const hasLiteralPair =
        typeof c.username === 'string' && typeof c.password === 'string';

      if (!hasEnvPair && !hasLiteralPair) {
        throw new Error(
          `Server \`${alias}\`: \`credentials\` needs either both \`usernameEnv\` and ` +
          `\`passwordEnv\`, or both \`username\` and \`password\`.`
        );
      }

      if (hasLiteralPair && !hasEnvPair) {
        console.error(
          `[config] Server \`${alias}\` uses literal credentials. The configuration ` +
          `file is git-ignored, but it still travels in pastes, backups and screen ` +
          `shares — prefer \`usernameEnv\`/\`passwordEnv\` where you can.`
        );
      }

      credentials = {
        usernameEnv: hasEnvPair ? (c.usernameEnv as string) : undefined,
        passwordEnv: hasEnvPair ? (c.passwordEnv as string) : undefined,
        username: hasLiteralPair ? (c.username as string) : undefined,
        password: hasLiteralPair ? (c.password as string) : undefined,
      };
    }

    const serviceProviders = (s.serviceProviders as unknown[] | undefined)?.map((sp, j) => {
      const p = (sp ?? {}) as Record<string, unknown>;
      if (typeof p.uri !== 'string' || p.uri.length === 0) {
        throw new Error(`Server \`${alias}\` serviceProviders[${j}]: \`uri\` is required.`);
      }
      return {
        uri: p.uri,
        alias: typeof p.alias === 'string' ? p.alias : undefined,
        configurationContext:
          typeof p.configurationContext === 'string' ? p.configurationContext : undefined,
      };
    });

    return {
      alias,
      baseUrl,
      // Left undefined when absent: resolving it needs a rootservices fetch,
      // which belongs at startup, not in a pure parser.
      catalogUrl: typeof s.catalogUrl === 'string' ? s.catalogUrl : undefined,
      configurationContext:
        typeof s.configurationContext === 'string' ? s.configurationContext : undefined,
      credentials,
      serviceProviders,
    };
  });

  return { servers: parsed };
}

export function loadConfigFile(path: string): ConfigFile {
  return parseConfigFile(readFileSync(path, 'utf8'));
}
