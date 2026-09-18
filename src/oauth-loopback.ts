import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';

export interface LoopbackOptions {
  /** Must match a redirect URI registered on the OAuth client, exactly. */
  redirectUri: string;
  /** The value that must come back, proving this redirect answers our request. */
  state: string;
  authorizeUrl: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to handing the URL to the desktop browser. */
  openBrowser?: (url: string) => Promise<void>;
}

/** Shown in the browser tab. The user has no other view of the outcome. */
function resultPage(heading: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:34rem;padding:0 1rem}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#444}</style></head>
<body><h1>${heading}</h1><p>${detail}</p></body></html>`;
}

/**
 * Open the system browser. Failure is reported, never fatal: on a headless host
 * there may be no browser, and the caller still prints the URL so the user can
 * open it themselves.
 */
async function openInBrowser(url: string): Promise<void> {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start'
            : 'xdg-open';
  await new Promise<void>((resolve) => {
    try {
      const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
      child.on('error', () => resolve());
      child.unref();
      resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Serve the loopback redirect once and return the authorization code.
 *
 * Loopback rather than a custom scheme (RFC 8252 §7.3): a server launched by an
 * MCP client is not registered as a protocol handler, so `oslc-mcp-server://…`
 * would never reach it.
 *
 * The listener binds 127.0.0.1 only — never 0.0.0.0 — so nothing off this
 * machine can reach it, and it is closed on every outcome so a retry can bind
 * the port again.
 */
export function awaitAuthorizationCode(opts: LoopbackOptions): Promise<string> {
  const { port, pathname } = (() => {
    const u = new URL(opts.redirectUri);
    return { port: Number(u.port || 80), pathname: u.pathname };
  })();
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const open = opts.openBrowser ?? openInBrowser;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Close before settling so the port is free the instant the caller
      // regains control — a retry must be able to bind it again.
      server.close(() => fn());
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== pathname) {
        // A browser fetches /favicon.ico unbidden; answering 404 keeps us listening.
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (error) {
        const detail = url.searchParams.get('error_description') ?? '';
        res.writeHead(200, { 'Content-Type': 'text/html' })
           .end(resultPage('Sign-in failed', 'You can close this tab and return to the terminal.'));
        finish(() => reject(new Error(`Authorization failed: ${error}${detail ? ` — ${detail}` : ''}`)));
        return;
      }

      // Checked before the code is used at all: a redirect carrying someone
      // else's code is exactly what `state` exists to catch.
      if (state !== opts.state) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
           .end(resultPage('Sign-in rejected', 'This redirect did not match the pending request.'));
        finish(() => reject(new Error('Authorization redirect carried an unexpected `state` — ignored.')));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
           .end(resultPage('Sign-in failed', 'The redirect carried no authorization code.'));
        finish(() => reject(new Error('Authorization redirect carried no code.')));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
         .end(resultPage('Signed in', 'You can close this tab and return to the terminal.'));
      finish(() => resolve(code));
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the sign-in redirect.`)));
    }, timeoutMs);
    // Do not hold the process open on this timer alone.
    timer.unref?.();

    server.on('error', (err) => finish(() => reject(err)));
    server.listen(port, '127.0.0.1', () => {
      open(opts.authorizeUrl).catch(() => { /* reported by the caller, never fatal */ });
    });
  });
}
