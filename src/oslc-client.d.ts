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

  export class OSLCClient {
    client: {
      /** Axios defaults — `headers.common` carries `Configuration-Context`. */
      defaults: { headers: { common: Record<string, string> } };
      get(url: string, config?: any): Promise<any>;
      post(url: string, data?: any, config?: any): Promise<any>;
      put(url: string, data?: any, config?: any): Promise<any>;
      delete(url: string, config?: any): Promise<any>;
    };

    constructor(user?: string, password?: string, configurationContext?: string | null);

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
