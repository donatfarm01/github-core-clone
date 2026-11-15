// The HTTP server: /healthz, git smart HTTP, REST v3, GraphQL v4, MCP.
// One process, stdlib only. Auth is a Bearer token (MAKEFUN_SHOP_TOKEN when
// the environment sets it; any Bearer token otherwise — the suite's token is
// opaque and the viewer login comes from the fixed scenario seed, not the
// token). /healthz takes no token. Every reply carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGraphql } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleMcp } from './mcp.ts';
import { routeRest } from './rest.ts';
import { viewerLogin } from './scenario.ts';
import { FIXED_EPOCH, Store } from './store.ts';

const OAUTH_SCOPES = 'repo, read:org';

/** Build the forge server: one in-memory store, the viewer login derived
 *  from the fixed scenario seed, and the trial clock for server commits. */
export function createApp(): ReturnType<typeof createServer> {
  const trialNow = Number.parseInt(process.env.MAKEFUN_TRIAL_NOW ?? '', 10);
  const serverEpoch = Number.isFinite(trialNow) && trialNow > 0 ? trialNow : FIXED_EPOCH;
  const store = new Store(viewerLogin(), serverEpoch);
  let requestCounter = 0;

  const sendJson = (res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void => {
    const body = value === null ? '' : JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': `req-${requestCounter}`,
      ...extraHeaders,
    });
    res.end(body);
  };

  const sendBuffer = (res: ServerResponse, status: number, contentType: string, body: Buffer): void => {
    res.writeHead(status, {
      'content-type': contentType,
      'x-github-request-id': `req-${requestCounter}`,
    });
    res.end(body);
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const server = createServer((req, res) => {
    void (async () => {
      requestCounter += 1;
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        if (pathname === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // ---- auth ------------------------------------------------------
        const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
        const authorization = req.headers.authorization ?? '';
        const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
        const authorized = bearer !== '' && (expectedToken === '' || bearer === expectedToken);
        if (!authorized) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }

        // ---- git smart HTTP --------------------------------------------
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const rest = gitMatch[3] as string;
          const repo = store.getRepo(owner, repoName);
          if (rest === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            const gitProtocolV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const answer = handleInfoRefs(store, repo, service, gitProtocolV2);
            sendBuffer(res, answer.status, answer.contentType, answer.body);
            return;
          }
          if (rest === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const gitProtocolV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const answer = handleUploadPack(store, repo, body, gitProtocolV2);
            sendBuffer(res, answer.status, answer.contentType, answer.body);
            return;
          }
          if (rest === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            const answer = handleReceivePack(store, repo, body);
            sendBuffer(res, answer.status, answer.contentType, answer.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // ---- REST v3 ----------------------------------------------------
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const rawBody = await readBody(req);
          let body: Record<string, unknown> | null = null;
          if (rawBody.length > 0) {
            try {
              const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
              body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
            } catch {
              sendJson(res, 400, { message: 'Bad Request' }, { 'x-oauth-scopes': OAUTH_SCOPES });
              return;
            }
          }
          const result = routeRest(store, method, pathname, url.searchParams, body, req.headers.host ?? 'localhost');
          const headers: Record<string, string> = { 'x-oauth-scopes': OAUTH_SCOPES, ...(result.headers ?? {}) };
          if (result.status === 204) {
            res.writeHead(204, { 'x-github-request-id': `req-${requestCounter}`, ...headers });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, headers);
          return;
        }

        // ---- GraphQL v4 -------------------------------------------------
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const rawBody = await readBody(req);
          let parsed: unknown = null;
          try {
            parsed = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : null;
          } catch {
            sendJson(res, 400, { message: 'Parse error' });
            return;
          }
          const result = handleGraphql(store, parsed);
          sendJson(res, result.status, result.body);
          return;
        }

        // ---- MCP ---------------------------------------------------------
        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204, { 'x-github-request-id': `req-${requestCounter}` });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const rawBody = await readBody(req);
          let parsed: unknown = null;
          let wasJson = true;
          try {
            parsed = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : null;
          } catch {
            wasJson = false;
          }
          const result = handleMcp(store, parsed, wasJson);
          if (result.status === 202) {
            res.writeHead(202, { 'x-github-request-id': `req-${requestCounter}` });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never let one bad request take the process down.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } catch {
          // The response is already gone; nothing more to do.
        }
      }
    })();
  });

  return server;
}
