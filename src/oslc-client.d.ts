declare module 'oslc-client' {
  import { IndexedFormula, NamedNode } from 'rdflib';

  export class OSLCResource {
    uri: NamedNode;
    store: IndexedFormula;
    etag: string | null;
    queryURI: string;
    getURI(): string;
    get(property: string): any;
    set(property: string, value: any): void;
    getTitle(): string | undefined;
    getDescription(): string | undefined;
    getIdentifier(): string | undefined;
    getProperties(): Record<string, any>;
  }

  /** Options for {@link OSLCClient}, added in oslc-client 4.2.0. */
  export interface OSLCClientOptions {
    /**
     * Supply an Authorization header per request; null uses oslc-client's own
     * mechanisms (JEE Forms, Basic, JAS bearer). Called before EVERY request
     * rather than in response to a challenge, because a server behind a bearer
     * token answers with an opaque 401 that carries no usable signal — the
     * scheme is configured by the host, never negotiated.
     *
     * oslc-client caches nothing here: only the host knows the credential's
     * lifetime and how to renew it. `forceRefresh` is true when the server
     * rejected the credential this provider last returned.
     */
    getAuthorization?: (ctx: { url: string; forceRefresh: boolean }) => Promise<string | null>;
  }

  /**
   * Raised when a host-supplied credential was refused and refreshing it did not
   * help. Deliberately NOT a fall back to Basic auth: falling through turns
   * "your token expired" into an exhausted auth ladder.
   */
  export class CredentialRejectedError extends Error {
    status: number | null;
    url: string | null;
    wwwAuthenticate: string | null;
  }

  export class OSLCClient {
    client: {
      /** Axios defaults — `headers.common` carries `Configuration-Context`. */
      defaults: { headers: { common: Record<string, string> } };
      get(url: string, config?: any): Promise<any>;
      post(url: string, data?: any, config?: any): Promise<any>;
      put(url: string, data?: any, config?: any): Promise<any>;
      delete(url: string, config?: any): Promise<any>;
    };

    constructor(
      user?: string,
      password?: string,
      configurationContext?: string | null,
      options?: OSLCClientOptions
    );

    /**
     * The OSLC Configuration-Context URI this client sends, or null. Set at
     * construction; `set_configuration_context` changes it at runtime, which
     * must also update `client.defaults.headers.common`.
     */
    configuration_context: string | null;

    getResource(
      url: string,
      oslcVersion?: string,
      accept?: string
    ): Promise<OSLCResource>;

    putResource(
      resource: OSLCResource,
      eTag?: string | null,
      oslcVersion?: string
    ): Promise<OSLCResource>;

    deleteResource(
      resource: OSLCResource,
      oslcVersion?: string
    ): Promise<void>;
  }
}
