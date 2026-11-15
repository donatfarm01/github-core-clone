// GraphQL v4 subset: the documents gh and github-mcp-server send, plus
// introspection for Issue / PullRequest / Repository / SearchType.
// Queries run over the same in-memory store as REST. Unknown fields return
// HTTP 200 with an `errors` array; an unknown repository returns
// `data.repository = null` with no errors.

import { FIXED_ISO, globalId, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ------------------------------------------------------------------- parser

interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  selection: GqlField[];
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selection: GqlField[];
}

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'var'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if ('{}():,![=]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '$') {
      const match = /^\$[_A-Za-z][_A-Za-z0-9]*/.exec(input.slice(i));
      if (!match) throw new Error('bad variable');
      tokens.push({ kind: 'var', value: match[0].slice(1) });
      i += match[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const escaped = input[j + 1] as string;
          out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?/.exec(input.slice(i));
      if (!match) throw new Error('bad number');
      tokens.push({ kind: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    const match = /^[_A-Za-z][_A-Za-z0-9]*/.exec(input.slice(i));
    if (!match) throw new Error(`unexpected character ${ch}`);
    tokens.push({ kind: 'name', value: match[0] });
    i += match[0].length;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}`);
    return token.value;
  }

  parseDocument(): { operations: GqlOperation[]; fragments: Map<string, GqlField[]> } {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlField[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        this.expectName();
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value as string;
        // Variable definitions: ($name: Type = default, ...)
        if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '(') {
          this.next();
          let depth = 1;
          while (depth > 0) {
            const t = this.next();
            if (t.kind === 'punct' && t.value === '(') depth += 1;
            else if (t.kind === 'punct' && t.value === ')') depth -= 1;
          }
        }
        operations.push({ kind, name, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)}`);
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (true) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return fields;
      }
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek() as Token;
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          this.expectName();
          fields.push(...this.parseSelectionSet());
        } else if (next.kind === 'name') {
          // Fragment spread: resolved by the caller via `fragments`.
          const name = this.next().value as string;
          fields.push({ name: `...${name}`, alias: null, args: {}, selection: [] });
        }
        continue;
      }
      fields.push(this.parseField());
    }
  }

  private parseField(): GqlField {
    let name = this.expectName();
    let alias: string | null = null;
    const next = this.peek();
    if (next?.kind === 'punct' && next.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, unknown> = {};
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '(') {
      this.next();
      while (true) {
        const token = this.peek() as Token;
        if (token.kind === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
        const after = this.peek();
        if (after?.kind === 'punct' && after.value === ',') this.next();
      }
    }
    // Directives (@include, @skip, ...): skip them.
    while (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          else if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selection: GqlField[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { name, alias, args, selection };
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'var') return { __var: token.value };
    if (token.kind === 'string' || token.kind === 'number') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (true) {
        const next = this.peek() as Token;
        if (next.kind === 'punct' && next.value === ']') {
          this.next();
          return items;
        }
        items.push(this.parseValue());
        const after = this.peek();
        if (after?.kind === 'punct' && after.value === ',') this.next();
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (true) {
        const next = this.peek() as Token;
        if (next.kind === 'punct' && next.value === '}') {
          this.next();
          return object;
        }
        const key = this.expectName();
        this.expectPunct(':');
        object[key] = this.parseValue();
        const after = this.peek();
        if (after?.kind === 'punct' && after.value === ',') this.next();
      }
    }
    throw new Error('unexpected value');
  }
}

function expandFragments(fields: GqlField[], fragments: Map<string, GqlField[]>): GqlField[] {
  const out: GqlField[] = [];
  for (const field of fields) {
    if (field.name.startsWith('...')) {
      const name = field.name.slice(3);
      const fragment = fragments.get(name);
      if (fragment) out.push(...expandFragments(fragment, fragments));
      continue;
    }
    out.push({ ...field, selection: expandFragments(field.selection, fragments) });
  }
  return out;
}

/** Replace {$__var} placeholders and {$__enum} markers with real values. */
function substitute(value: unknown, variables: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, variables));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('__var' in record) return variables[record.__var as string];
    if ('__enum' in record) return record.__enum as string;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = substitute(entry, variables);
    return out;
  }
  return value;
}

function substituteFields(fields: GqlField[], variables: Record<string, unknown>): GqlField[] {
  return fields.map((field) => ({
    ...field,
    args: substitute(field.args, variables) as Record<string, unknown>,
    selection: substituteFields(field.selection, variables),
  }));
}

// ------------------------------------------------------------------- introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login', 'id', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'createdAt', 'updatedAt', 'url', 'isPrivate',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt',
    'author', 'labels', 'comments', 'repository',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'files', 'author',
    'createdAt', 'updatedAt',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'name'],
  Label: ['name', 'color'],
};

const SEARCH_TYPE_VALUES = [
  'COMMIT', 'DISCUSSION', 'ISSUE', 'LABEL', 'MILESTONE', 'PROJECT', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'WIKI', 'CODE',
];

function introspectType(name: string): Record<string, unknown> | null {
  if (name === 'SearchType') {
    return { name, kind: 'ENUM', enumValues: SEARCH_TYPE_VALUES.map((value) => ({ name: value })) };
  }
  const fields = TYPE_FIELDS[name];
  if (!fields) return null;
  return {
    name,
    kind: 'OBJECT',
    fields: fields.map((field) => ({ name: field })),
  };
}

function introspectSchema(): Record<string, unknown> {
  return {
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    types: [...Object.keys(TYPE_FIELDS), 'SearchType'].map((name) => ({ name })),
  };
}

export { FIXED_ISO, globalId };
export type { Issue, Pull, Repo, Store };

// ------------------------------------------------------------------- execution

class UnknownField extends Error {}

interface Ctx {
  store: Store;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number.parseInt(match[1] as string, 10) : null;
  } catch {
    return null;
  }
}

interface ConnectionItem {
  number: number;
  value: unknown;
}

function buildConnection(
  items: ConnectionItem[],
  args: Record<string, unknown>,
  orderDesc: boolean,
): Record<string, unknown> {
  const sorted = [...items].sort((a, b) => (orderDesc ? b.number - a.number : a.number - b.number));
  const after = cursorNumber(typeof args.after === 'string' ? args.after : undefined);
  let rest = after === null ? sorted : sorted.filter((item) => (orderDesc ? item.number < after : item.number > after));
  const first = typeof args.first === 'number' ? args.first : 100;
  const page = rest.slice(0, first);
  const hasNextPage = rest.length > first;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  return {
    nodes: page.map((item) => item.value),
    edges: page.map((item) => ({ node: item.value, cursor: cursorFor(item.number) })),
    pageInfo: {
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? cursorFor(page[0]?.number ?? 0) : null,
      endCursor,
    },
    totalCount: sorted.length,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueValue(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __type: 'Issue',
    __repo: repo,
    __issue: issue,
    id: issue.globalId,
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  };
}

function pullValue(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __type: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: pull.globalId,
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    mergeable: ctx.store.pullMergeable(repo, pull),
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  };
}

function repoValue(ctx: Ctx, repo: Repo): Record<string, unknown> {
  return {
    __type: 'Repository',
    __repo: repo,
    id: repo.globalId,
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    isPrivate: repo.private,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  };
}

function userValue(login: string): Record<string, unknown> {
  return { __type: 'User', login, id: 1000, name: login };
}

function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    const type = parts.shift();
    if (!type) return null;
    return { type, parts };
  } catch {
    return null;
  }
}

function resolveNode(ctx: Ctx, id: string): Record<string, unknown> | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const { type, parts } = decoded;
  if (type === 'Repository') {
    const repo = ctx.store.listRepos().find((entry) => entry.dbId === Number(parts[0]));
    return repo ? repoValue(ctx, repo) : null;
  }
  if (type === 'Issue' || type === 'PullRequest') {
    const repo = ctx.store.listRepos().find((entry) => entry.dbId === Number(parts[0]));
    if (!repo) return null;
    if (type === 'Issue') {
      const issue = ctx.store.getIssue(repo, Number(parts[1]));
      return issue ? issueValue(ctx, repo, issue) : null;
    }
    const pull = ctx.store.getPull(repo, Number(parts[1]));
    return pull ? pullValue(ctx, repo, pull) : null;
  }
  if (type === 'IssueComment') {
    const repo = ctx.store.listRepos().find((entry) => entry.dbId === Number(parts[0]));
    if (!repo) return null;
    const issue = ctx.store.getIssue(repo, Number(parts[1]));
    if (!issue) return null;
    const comment = issue.comments.find((entry) => entry.id === Number(parts[2]));
    if (!comment) return null;
    return { __type: 'IssueComment', id: comment.globalId, databaseId: comment.id, body: comment.body, createdAt: FIXED_ISO, updatedAt: FIXED_ISO };
  }
  return null;
}

function resolveField(ctx: Ctx, parent: Record<string, unknown>, field: GqlField): unknown {
  const typeName = (parent.__type as string | undefined) ?? 'Object';
  const name = field.name;
  if (name === '__typename') return typeName;

  // Introspection pseudo-fields on the root.
  if (typeName === 'Query' && name === '__schema') return { __type: '__Schema', ...introspectSchema() };
  if (typeName === 'Query' && name === '__type') {
    const typeNameArg = field.args.name;
    if (typeof typeNameArg !== 'string') return null;
    const type = introspectType(typeNameArg);
    return type ? { __type: '__Type', ...type } : null;
  }

  // Plain objects (introspection results, connections, edges): property lookup.
  if (!parent.__type) {
    const value = parent[name];
    if (value === undefined) throw new UnknownField(`Cannot query field "${name}" on type "${typeName}".`);
    return value;
  }

  if (typeName === 'Query') {
    if (name === 'viewer') return { __type: 'Viewer', login: ctx.store.viewerLogin, id: 1000, name: ctx.store.viewerLogin };
    if (name === 'repository') {
      const owner = field.args.owner;
      const repoName = field.args.name;
      if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
      const repo = ctx.store.getRepo(owner, repoName);
      return repo ? repoValue(ctx, repo) : null;
    }
    if (name === 'node') {
      const id = field.args.id;
      return typeof id === 'string' ? resolveNode(ctx, id) : null;
    }
    if (name === 'search') {
      const query = typeof field.args.query === 'string' ? field.args.query.toLowerCase() : '';
      const matches: ConnectionItem[] = [];
      for (const repo of ctx.store.listRepos()) {
        for (const issue of repo.issues) {
          if (issue.title.toLowerCase().includes(query) || issue.body.toLowerCase().includes(query)) {
            matches.push({ number: issue.number, value: issueValue(ctx, repo, issue) });
          }
        }
      }
      const connection = buildConnection(matches, field.args, false);
      return { __type: 'SearchResultItemConnection', ...connection, issueCount: matches.length };
    }
    throw new UnknownField(`Cannot query field "${name}" on type "Query".`);
  }

  if (typeName === 'Viewer' || typeName === 'User') {
    if (name === 'login' || name === 'name') return parent[name];
    if (name === 'id') return parent.id;
    throw new UnknownField(`Cannot query field "${name}" on type "${typeName}".`);
  }

  if (typeName === 'Repository') {
    const repo = parent.__repo as Repo;
    if (name === 'owner') return userValue(repo.owner);
    if (name === 'defaultBranchRef') {
      return { __type: 'Ref', name: repo.defaultBranch, target: { oid: ctx.store.refCommit(repo, `refs/heads/${repo.defaultBranch}`) ?? '' } };
    }
    if (name === 'issue') {
      const number = field.args.number;
      if (typeof number !== 'number') return null;
      const issue = ctx.store.getIssue(repo, number);
      return issue ? issueValue(ctx, repo, issue) : null;
    }
    if (name === 'issues') {
      const states = Array.isArray(field.args.states) ? (field.args.states as string[]) : null;
      let issues = [...repo.issues];
      if (states) {
        const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = field.args.orderBy as Record<string, unknown> | undefined;
      const orderDesc = orderBy?.direction === 'DESC';
      return buildConnection(
        issues.map((issue) => ({ number: issue.number, value: issueValue(ctx, repo, issue) })),
        field.args,
        orderDesc,
      );
    }
    if (name === 'pullRequest') {
      const number = field.args.number;
      if (typeof number !== 'number') return null;
      const pull = ctx.store.getPull(repo, number);
      return pull ? pullValue(ctx, repo, pull) : null;
    }
    if (name === 'pullRequests') {
      const states = Array.isArray(field.args.states) ? (field.args.states as string[]) : null;
      let pulls = [...repo.pulls];
      if (states) {
        const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'MERGED' ? 'closed' : 'closed')));
        pulls = pulls.filter((pull) => {
          if (states.includes('MERGED')) return pull.merged;
          return wanted.has(pull.state);
        });
      }
      const orderBy = field.args.orderBy as Record<string, unknown> | undefined;
      const orderDesc = orderBy?.direction === 'DESC';
      return buildConnection(
        pulls.map((pull) => ({ number: pull.number, value: pullValue(ctx, repo, pull) })),
        field.args,
        orderDesc,
      );
    }
    if (name in parent) return parent[name];
    throw new UnknownField(`Cannot query field "${name}" on type "Repository".`);
  }

  if (typeName === 'Issue') {
    const repo = parent.__repo as Repo;
    const issue = parent.__issue as Issue;
    if (name === 'author') return userValue(repo.owner);
    if (name === 'repository') return repoValue(ctx, repo);
    if (name === 'labels') {
      const nodes = issue.labels.map((labelName) => ({ __type: 'Label', name: labelName, color: repo.labels.get(labelName)?.color ?? 'ededed' }));
      return { __type: 'LabelConnection', nodes, edges: nodes.map((node) => ({ node, cursor: cursorFor(0) })), pageInfo: { hasNextPage: false, endCursor: null }, totalCount: nodes.length };
    }
    if (name === 'comments') {
      const nodes = issue.comments.map((comment) => ({
        __type: 'IssueComment',
        id: comment.globalId,
        databaseId: comment.id,
        body: comment.body,
        createdAt: FIXED_ISO,
        updatedAt: FIXED_ISO,
      }));
      return { __type: 'IssueCommentConnection', nodes, edges: nodes.map((node) => ({ node, cursor: cursorFor(0) })), pageInfo: { hasNextPage: false, endCursor: null }, totalCount: nodes.length };
    }
    if (name in parent) return parent[name];
    throw new UnknownField(`Cannot query field "${name}" on type "Issue".`);
  }

  if (typeName === 'PullRequest') {
    const repo = parent.__repo as Repo;
    const pull = parent.__pull as Pull;
    if (name === 'author') return userValue(repo.owner);
    if (name === 'repository') return repoValue(ctx, repo);
    if (name === 'files') {
      const files = ctx.store.pullFiles(repo, pull);
      const nodes = files.map((file) => ({
        __type: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'deleted' ? 'DELETED' : 'MODIFIED',
      }));
      return { __type: 'PullRequestChangedFileConnection', nodes, edges: nodes.map((node) => ({ node, cursor: cursorFor(0) })), pageInfo: { hasNextPage: false, endCursor: null }, totalCount: nodes.length };
    }
    if (name in parent) return parent[name];
    throw new UnknownField(`Cannot query field "${name}" on type "PullRequest".`);
  }

  if (typeName === 'IssueComment') {
    if (name === 'author') return userValue(ctx.store.viewerLogin);
    if (name in parent) return parent[name];
    throw new UnknownField(`Cannot query field "${name}" on type "IssueComment".`);
  }

  // Generic container (edges, pageInfo, introspection objects): property lookup.
  if (name in parent) return parent[name];
  throw new UnknownField(`Cannot query field "${name}" on type "${typeName}".`);
}

function executeSelection(ctx: Ctx, parent: Record<string, unknown>, fields: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    const value = resolveField(ctx, parent, field);
    out[key] = projectValue(ctx, value, field.selection);
  }
  return out;
}

function projectValue(ctx: Ctx, value: unknown, selection: GqlField[]): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => projectValue(ctx, entry, selection));
  if (typeof value === 'object') {
    if (selection.length === 0) return value;
    return executeSelection(ctx, value as Record<string, unknown>, selection);
  }
  return value;
}

// ------------------------------------------------------------------- mutations

function resolveMutation(ctx: Ctx, field: GqlField): Record<string, unknown> {
  const input = (field.args.input ?? {}) as Record<string, unknown>;
  const store = ctx.store;
  if (field.name === 'createIssue') {
    const repoId = input.repositoryId;
    if (typeof repoId !== 'string') throw new Error('repositoryId is required');
    const decoded = decodeGlobalId(repoId);
    const repo = decoded ? store.listRepos().find((entry) => entry.dbId === Number(decoded.parts[0])) : undefined;
    if (!repo) throw new Error('repository not found');
    const title = typeof input.title === 'string' ? input.title : '';
    const created = store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
    if ('error' in created) throw new Error(`label ${created.label} does not exist`);
    return { issue: projectValue(ctx, issueValue(ctx, repo, created), field.selection[0]?.selection ?? []) };
  }
  if (field.name === 'closeIssue') {
    const issueId = input.issueId;
    if (typeof issueId !== 'string') throw new Error('issueId is required');
    const decoded = decodeGlobalId(issueId);
    const repo = decoded ? store.listRepos().find((entry) => entry.dbId === Number(decoded.parts[0])) : undefined;
    const issue = repo && decoded ? store.getIssue(repo, Number(decoded.parts[1])) : undefined;
    if (!repo || !issue) throw new Error('issue not found');
    issue.state = 'closed';
    return { issue: projectValue(ctx, issueValue(ctx, repo, issue), field.selection[0]?.selection ?? []) };
  }
  if (field.name === 'createPullRequest') {
    const repoId = input.repositoryId;
    if (typeof repoId !== 'string') throw new Error('repositoryId is required');
    const decoded = decodeGlobalId(repoId);
    const repo = decoded ? store.listRepos().find((entry) => entry.dbId === Number(decoded.parts[0])) : undefined;
    if (!repo) throw new Error('repository not found');
    const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
    const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRefName && pull.baseRef === baseRefName);
    const pull = existing ?? store.createPull(repo, headRefName, baseRefName, typeof input.title === 'string' ? input.title : '', '');
    if ('error' in pull) throw new Error('head or base branch does not exist');
    return { pullRequest: projectValue(ctx, pullValue(ctx, repo, pull), field.selection[0]?.selection ?? []) };
  }
  if (field.name === 'mergePullRequest') {
    const pullRequestId = input.pullRequestId;
    if (typeof pullRequestId !== 'string') throw new Error('pullRequestId is required');
    const decoded = decodeGlobalId(pullRequestId);
    const repo = decoded ? store.listRepos().find((entry) => entry.dbId === Number(decoded.parts[0])) : undefined;
    const pull = repo && decoded ? store.getPull(repo, Number(decoded.parts[1])) : undefined;
    if (!repo || !pull) throw new Error('pull request not found');
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) throw new Error(merged.error === 'conflict' ? 'merge conflict' : 'pull request is not open');
    return { pullRequest: projectValue(ctx, pullValue(ctx, repo, pull), field.selection[0]?.selection ?? []) };
  }
  if (field.name === 'addComment') {
    const subjectId = input.subjectId;
    if (typeof subjectId !== 'string') throw new Error('subjectId is required');
    const decoded = decodeGlobalId(subjectId);
    const repo = decoded ? store.listRepos().find((entry) => entry.dbId === Number(decoded.parts[0])) : undefined;
    const issue = repo && decoded ? store.getIssue(repo, Number(decoded.parts[1])) : undefined;
    if (!repo || !issue) throw new Error('issue not found');
    const comment = store.addComment(repo, issue, typeof input.body === 'string' ? input.body : '');
    const node = {
      __type: 'IssueComment',
      id: comment.globalId,
      databaseId: comment.id,
      body: comment.body,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
    };
    const nodeSelection = field.selection[0]?.selection ?? [];
    const commentEdge = nodeSelection.find((entry) => entry.name === 'node');
    return { commentEdge: { node: projectValue(ctx, node, commentEdge?.selection ?? []) } };
  }
  throw new UnknownField(`Cannot query field "${field.name}" on type "Mutation".`);
}

function executeOperation(ctx: Ctx, operation: GqlOperation, fragments: Map<string, GqlField[]>, variables: Record<string, unknown>): Record<string, unknown> {
  try {
    const expanded = expandFragments(operation.selection, fragments);
    const withVars = substituteFields(expanded, variables);
    if (operation.kind === 'mutation') {
      const out: Record<string, unknown> = {};
      for (const field of withVars) out[field.alias ?? field.name] = resolveMutation(ctx, field);
      return { data: out };
    }
    const root: Record<string, unknown> = { __type: 'Query' };
    return { data: executeSelection(ctx, root, withVars) };
  } catch (err) {
    if (err instanceof UnknownField) return { data: null, errors: [{ message: err.message }] };
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'internal error' }] };
  }
}

// ------------------------------------------------------------------- entry point

export interface GraphqlResult {
  status: number;
  body: unknown;
}

/** Handle one POST /api/graphql body (object, or an array of requests). */
export function handleGraphql(store: Store, body: unknown): GraphqlResult {
  const ctx: Ctx = { store };
  const runOne = (request: unknown): Record<string, unknown> => {
    if (!request || typeof request !== 'object') return { data: null, errors: [{ message: 'request must be an object' }] };
    const record = request as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    let variables: Record<string, unknown> = {};
    if (record.variables && typeof record.variables === 'object') variables = record.variables as Record<string, unknown>;
    else if (typeof record.variables === 'string') {
      try {
        variables = JSON.parse(record.variables) as Record<string, unknown>;
      } catch {
        variables = {};
      }
    }
    let parsed: { operations: GqlOperation[]; fragments: Map<string, GqlField[]> };
    try {
      parsed = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
    if (parsed.operations.length === 0) return { data: null, errors: [{ message: 'no operation' }] };
    if (parsed.operations.length === 1) {
      return executeOperation(ctx, parsed.operations[0] as GqlOperation, parsed.fragments, variables);
    }
    // Several operations in one document: run them all, merge the data.
    const data: Record<string, unknown> = {};
    for (const operation of parsed.operations) {
      const result = executeOperation(ctx, operation, parsed.fragments, variables);
      if (result.errors) return result;
      Object.assign(data, result.data as Record<string, unknown>);
    }
    return { data };
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((request) => runOne(request)) };
  }
  return { status: 200, body: runOne(body) };
}
