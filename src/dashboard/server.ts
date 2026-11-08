/**
 * The dashboard's web server: read only (GET and HEAD), the page at /, its data at /api/status, /api/health, and the
 * result folders at /share/<name>/ (share.ts). The one write is the usage settings (/settings, POST /api/usage-settings
 * with JSON from that page: which providers' usage is read, usage-settings.ts). One listener per address (127.0.0.1 always, for Tailscale Serve and this
 * PC; the tailnet address from the settings for the old plain http address). No login: only what reaches those
 * addresses can open it.
 */
import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Share } from './share.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  refreshSec: number;
  share: Share;
  status: () => Promise<unknown>;
  /** The usage settings (usage-settings.ts): what the page shows, and saving a choice (throws TypeError on bad input). */
  usage?: { view: () => unknown; save: (input: unknown) => unknown };
}

/** The one address that takes a write: the usage settings, JSON only, from the dashboard's own page. */
export const USAGE_SETTINGS_PATH = '/api/usage-settings';
const MAX_BODY = 8 * 1024;

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Past the limit the rest is read and dropped (the answer still goes out on the same connection).
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Whether a write comes from the dashboard's own page: JSON (a form on another site cannot send it without asking first,
 * which this server never allows), and an Origin, when there is one, of this same address.
 */
function sameSiteJson(req: IncomingMessage): boolean {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return false;
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function pageHtml(refreshSec: number, shareNames: string[]): string {
  const links = shareNames.map((n) => `<a href="/share/${encodeURIComponent(n)}/">${esc(n)}</a>`).join('') || '<span class="empty">없음</span>';
  return fs.readFileSync(path.join(HERE, 'page.html'), 'utf8').replace('__REFRESH__', String(refreshSec)).replace('__SHARES__', links);
}

const send = (res: ServerResponse, head: boolean, code: number, type: string, body: string) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(head ? undefined : body);
};

export function handler(o: ServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const page = pageHtml(o.refreshSec, o.share.names);
  const settingsPage = fs.readFileSync(path.join(HERE, 'settings.html'), 'utf8');
  const json = (res: ServerResponse, head: boolean, code: number, v: unknown) => send(res, head, code, 'application/json; charset=utf-8', JSON.stringify(v));
  return (req, res) => {
    void (async () => {
      const head = req.method === 'HEAD';
      const raw = req.url ?? '/';
      const q = raw.indexOf('?');
      const p = q < 0 ? raw : raw.slice(0, q);
      const query = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
      if (req.method === 'POST' && p === USAGE_SETTINGS_PATH && o.usage) {
        if (!sameSiteJson(req)) return json(res, false, 403, { error: '대시보드 화면에서 보낸 JSON만 받습니다' });
        const body = await readBody(req);
        if (body === null) return json(res, false, 413, { error: '너무 큼' });
        let input: unknown;
        try {
          input = JSON.parse(body);
        } catch {
          return json(res, false, 400, { error: 'JSON이 아님' });
        }
        try {
          o.usage.save(input);
        } catch (e) {
          if (e instanceof TypeError) return json(res, false, 400, { error: e.message });
          throw e;
        }
        return json(res, false, 200, o.usage.view());
      }
      if (req.method !== 'GET' && !head) {
        res.setHeader('Allow', p === USAGE_SETTINGS_PATH && o.usage ? 'GET, HEAD, POST' : 'GET, HEAD');
        return send(res, false, 405, 'text/plain; charset=utf-8', '읽기 전용입니다');
      }
      if (p === '/') return send(res, head, 200, 'text/html; charset=utf-8', page);
      if (p === '/settings' && o.usage) return send(res, head, 200, 'text/html; charset=utf-8', settingsPage);
      if (p === USAGE_SETTINGS_PATH && o.usage) return json(res, head, 200, o.usage.view());
      if (p === '/api/health') return send(res, head, 200, 'application/json', '{"ok":true}');
      if (p === '/api/status') return send(res, head, 200, 'application/json; charset=utf-8', JSON.stringify(await o.status()));
      if (p === '/share' || p === '/share/') {
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
        return void res.end();
      }
      if (p.startsWith('/share/')) return o.share.handle(req, res, p, query);
      send(res, head, 404, 'text/plain; charset=utf-8', '없는 주소입니다');
    })().catch(() => {
      if (!res.headersSent) send(res, false, 500, 'text/plain; charset=utf-8', '서버 오류');
      else res.destroy();
    });
  };
}

export interface Listening {
  servers: Server[];
  /** host → the port it really listens on (port 0 picks one). */
  ports: Record<string, number>;
  close: () => Promise<void>;
}

/**
 * Listens on every host. A port already taken means the dashboard runs already: onTaken (the server command ends
 * quietly). An address not there yet (Tailscale not up) is tried again every retryMs while the rest serve.
 */
export function listen(
  o: ServerOptions,
  hosts: string[],
  port: number,
  { onTaken, onError, retryMs = 10000 }: { onTaken: (host: string) => void; onError: (host: string, e: NodeJS.ErrnoException) => void; retryMs?: number },
): Promise<Listening> {
  const h = handler(o);
  const servers: Server[] = [];
  const ports: Record<string, number> = {};
  const timers = new Set<NodeJS.Timeout>();
  const one = (host: string) =>
    new Promise<void>((resolve) => {
      const server = createServer(h);
      servers.push(server);
      let first = true;
      const done = () => {
        if (first) (first = false), resolve();
      };
      server.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') onTaken(host);
        else if (e.code === 'EADDRNOTAVAIL') {
          const t = setTimeout(() => (timers.delete(t), server.listen(port, host)), retryMs);
          timers.add(t);
        } else onError(host, e);
        done();
      });
      server.on('listening', () => {
        const a = server.address();
        if (a && typeof a === 'object') ports[host] = a.port;
        done();
      });
      server.listen(port, host);
    });
  return Promise.all(hosts.map(one)).then(() => ({
    servers,
    ports,
    close: async () => {
      for (const t of timers) clearTimeout(t);
      await Promise.all(servers.map((s) => new Promise<void>((r) => (s.listening ? (s.close(() => r()), s.closeAllConnections()) : r()))));
    },
  }));
}
