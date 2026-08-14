/**
 * Configuration for one OSLC server, resolved from the configuration file
 * or from CLI args and environment variables.
 * Stays local to oslc-mcp-server — not part of the shared MCP layer.
 */
export interface ServerConfig {
  serverURL: string;
  catalogURL: string;
  username: string;
  password: string;
  /**
   * OSLC Configuration-Context URI. Required against configuration-enabled
   * ELM project areas, where a request without one cannot name which
   * stream or baseline it applies to.
   */
  configurationContext?: string;
}

/** One configured server, ready to construct a client for. */
export interface ResolvedServer {
  alias: string;
  config: ServerConfig;
  /** Empty means walk the catalog; non-empty means scoped discovery. */
  serviceProviderURIs: string[];
}
