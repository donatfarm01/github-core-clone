// MCP over Streamable HTTP (JSON-RPC 2.0): the 2026-07-28 revision via
// `server/discover`, plus the legacy `initialize` handshake for older
// clients. Tools act on the same store as REST, so a repo or issue created
// over MCP reads back over /api/v3 as the same object.

import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Store } from './store.ts';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the authenticated user repositories.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
        body: { type: 'string', description: 'The comment body.' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
];

const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };

/** Find a tool by name, allowing a server prefix (github__create_issue). */
function findTool(name: string): McpToolDef | undefined {
  const wanted = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const exact = TOOLS.find((tool) => tool.name.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted);
  if (exact) return exact;
  return TOOLS.find((tool) => {
    const normalized = tool.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return wanted.length > normalized.length && wanted.endsWith(normalized);
  });
}

/** Resolve one argument: the exact property name, then case-insensitive and
 *  snake/camel variants, then the suite's aliases. */
function pickArg(args: Record<string, unknown>, property: string, aliases: string[] = []): unknown {
  if (property in args) return args[property];
  const wanted = property.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const key of Object.keys(args)) {
    if (key.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted) return args[key];
  }
  for (const alias of aliases) {
    if (alias in args) return args[alias];
    const aliasWanted = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const key of Object.keys(args)) {
      if (key.toLowerCase().replace(/[^a-z0-9]/g, '') === aliasWanted) return args[key];
    }
  }
  return undefined;
}

function textResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (!tool) return { __rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  for (const property of required) {
    if (pickArg(args, property) === undefined) {
      return toolError(`missing required argument: ${property}`);
    }
  }
  const owner = pickArg(args, 'owner', ['owner_login', 'login', 'user', 'owner_name']);
  const repoName = pickArg(args, 'repo', ['repository', 'repository_name', 'repo_name']);
  const fullName = pickArg(args, 'full_name', ['repo_full_name', 'fullName']);
  const resolveRepo = (): ReturnType<Store['getRepo']> => {
    if (typeof owner === 'string' && typeof repoName === 'string') return store.getRepo(owner, repoName);
    if (typeof fullName === 'string') {
      const [o, r] = fullName.split('/');
      if (o && r) return store.getRepo(o, r);
    }
    return undefined;
  };

  if (tool.name === 'create_repo') {
    const repoNameArg = pickArg(args, 'name', ['repo', 'repository']) as string | undefined;
    if (typeof repoNameArg !== 'string' || repoNameArg === '') return toolError('missing required argument: name');
    const description = pickArg(args, 'description') as string | undefined;
    const isPrivate = pickArg(args, 'private', ['is_private']);
    const repo = store.createRepo(repoNameArg, isPrivate === true, typeof description === 'string' ? description : '');
    if (!repo) return toolError(`repository ${repoNameArg} already exists`);
    return textResult(repoJson(store, repo));
  }
  if (tool.name === 'list_repos') {
    return textResult(store.listRepos().map((repo) => repoJson(store, repo)));
  }
  if (tool.name === 'get_repo') {
    const repo = resolveRepo();
    if (!repo) return toolError('repository not found');
    return textResult(repoJson(store, repo));
  }
  if (tool.name === 'create_issue') {
    const repo = resolveRepo();
    if (!repo) return toolError('repository not found');
    const title = pickArg(args, 'title', ['issue_title', 'subject']) as string | undefined;
    if (typeof title !== 'string' || title === '') return toolError('missing required argument: title');
    const body = pickArg(args, 'body', ['issue_body', 'description', 'content', 'text']) as string | undefined;
    const created = store.createIssue(repo, title, typeof body === 'string' ? body : '', []);
    if ('error' in created) return toolError(`label ${created.label} does not exist`);
    return textResult(issueJson(store, repo, created));
  }
  if (tool.name === 'get_issue') {
    const repo = resolveRepo();
    if (!repo) return toolError('repository not found');
    const number = pickArg(args, 'issue_number', ['number', 'index']);
    const issue = typeof number === 'number' ? store.getIssue(repo, number) : undefined;
    if (!issue) return toolError('issue not found');
    return textResult(issueJson(store, repo, issue));
  }
  if (tool.name === 'list_issues') {
    const repo = resolveRepo();
    if (!repo) return toolError('repository not found');
    const state = pickArg(args, 'state', ['status']) as string | undefined;
    let issues = [...repo.issues];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    return textResult(issues.map((issue) => issueJson(store, repo, issue)));
  }
  if (tool.name === 'create_pull_request') {
    const repo = resolveRepo();
    if (!repo) return toolError('repository not found');
    const title = pickArg(args, 'title', ['pr_title', 'pull_request_title', 'subject']) as string | undefined;
    const head = pickArg(args, 'head', ['head_ref', 'head_branch', 'source_branch', 'from_branch', 'branch']) as string | undefined;
    const base = pickArg(args, 'base', ['base_ref', 'base_branch', 'target_branch', 'into_branch']) as string | undefined;
    if (typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
      return toolError('title, head and base are required');
    }
    const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    const body = pickArg(args, 'body', ['description', 'content', 'text']) as string | undefined;
    const pull = existing ?? store.createPull(repo, head, base, title, typeof body === 'string' ? body : '');
    if ('error' in pull) return toolError('head or base branch does not exist');
    return textResult(pullJson(store, repo, pull));
  }
  if (tool.name === 'get_pull_request') {
    const repo = resolveRepo();
    if (!repo) return toolError('repository not found');
    const number = pickArg(args, 'pull_number', ['pull_request_number', 'pr_number', 'number', 'index']);
    const pull = typeof number === 'number' ? store.getPull(repo, number) : undefined;
    if (!pull) return toolError('pull request not found');
    return textResult(pullJson(store, repo, pull));
  }
  if (tool.name === 'list_pull_requests') {
    const repo = resolveRepo();
    if (!repo) return toolError('repository not found');
    const state = pickArg(args, 'state', ['status']) as string | undefined;
    let pulls = [...repo.pulls];
    if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
    else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    return textResult(pulls.map((pull) => pullJson(store, repo, pull)));
  }
  if (tool.name === 'merge_pull_request') {
    const repo = resolveRepo();
    if (!repo) return toolError('repository not found');
    const number = pickArg(args, 'pull_number', ['pull_request_number', 'pr_number', 'number', 'index']);
    const pull = typeof number === 'number' ? store.getPull(repo, number) : undefined;
    if (!pull) return toolError('pull request not found');
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) return toolError(merged.error === 'conflict' ? 'merge conflict' : 'pull request is not open');
    return textResult(pullJson(store, repo, pull));
  }
  if (tool.name === 'add_comment') {
    const repo = resolveRepo();
    if (!repo) return toolError('repository not found');
    const number = pickArg(args, 'issue_number', ['number', 'index']);
    const issue = typeof number === 'number' ? store.getIssue(repo, number) : undefined;
    if (!issue) return toolError('issue not found');
    const body = pickArg(args, 'body', ['comment', 'content', 'text', 'description']) as string | undefined;
    if (typeof body !== 'string') return toolError('missing required argument: body');
    const comment = store.addComment(repo, issue, body);
    return textResult({ id: comment.id, node_id: comment.globalId, body: comment.body });
  }
  return toolError(`tool ${tool.name} is not implemented`);
}

export interface McpResult {
  status: number;
  body: unknown;
}

function handleOne(store: Store, request: unknown): { status: number; body: unknown } | null {
  // Returns null for notifications (no JSON-RPC response).
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const record = request as Record<string, unknown>;
  const id = record.id;
  const hasId = id !== undefined && id !== null;
  if (!hasId) {
    // A notification (initialize acknowledgement, etc.): no response body.
    return null;
  }
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;
  const ok = (result: unknown): { status: number; body: unknown } => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const fail = (code: number, message: string): { status: number; body: unknown } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });
  if (method === 'server/discover') {
    return ok({
      supportedVersions: SUPPORTED_REVISIONS,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const requested = (params.protocolVersion as string | undefined) ?? '';
    const protocolVersion = SUPPORTED_REVISIONS.includes(requested) ? requested : '2026-07-28';
    return ok({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    // The same list every time, byte-for-byte: TOOLS is a constant.
    return ok({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const result = callTool(store, name, args);
    if ('__rpcError' in result) {
      const rpcError = result.__rpcError as { code: number; message: string };
      return fail(rpcError.code, rpcError.message);
    }
    return ok(result);
  }
  return fail(-32601, `Method not found: ${method}`);
}

/** Handle one POST /mcp body. `body` is the parsed JSON (or null when the
 *  request body was not JSON at all). */
export function handleMcp(store: Store, body: unknown, bodyWasJson: boolean): McpResult {
  if (!bodyWasJson) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(body)) {
    const results: unknown[] = [];
    for (const request of body) {
      const answer = handleOne(store, request);
      if (answer !== null) results.push(answer.body);
    }
    return { status: 200, body: results };
  }
  const answer = handleOne(store, body);
  if (answer === null) return { status: 202, body: null };
  return answer;
}
