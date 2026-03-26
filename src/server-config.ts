/**
 * Configuration parsed from CLI args and env vars.
 * Stays local to oslc-mcp-server — not part of the shared MCP layer.
 */
export interface ServerConfig {
  serverURL: string;
  catalogURL: string;
  username: string;
  password: string;
}
