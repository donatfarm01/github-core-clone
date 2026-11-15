// GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, all over the one in-memory store.
// Every reply is application/json with a non-empty X-GitHub-Request-Id
// (set by app.ts); errors carry a string `message`.

import {
  FIXED_EPOCH,
  FIXED_ISO,
  globalId,
  isOid,
  lineCount,
  parseCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

export function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, node_id: globalId('User', 1000), type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner, type: 'User' } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner, type: 'User' } },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function authorJson(identity: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(identity);
  if (!match) return { name: identity, email: '', date: FIXED_ISO };
  const epoch = Number.parseInt(match[3] as string, 10);
  const date = Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : FIXED_ISO;
  return { name: match[1] as string, email: match[2] as string, date };
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid.toLowerCase());
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  return {
    sha: oid.toLowerCase(),
    node_id: globalId('Commit', oid.toLowerCase()),
    commit: {
      message: parsed.message,
      author: authorJson(parsed.author),
      committer: authorJson(parsed.committer),
      tree: { sha: parsed.tree },
    },
    author: { login: store.viewerLogin, type: 'User' },
    committer: { login: store.viewerLogin, type: 'User' },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
  };
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** A Link header for a paginated list, built from the request's own host. */
export function linkHeader(host: string, basePath: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const urlFor = (p: number): string => {
    const next = new URLSearchParams(query);
    next.set('page', String(p));
    next.set('per_page', String(perPage));
    return `http://${host}${basePath}?${next.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

type Body = Record<string, unknown> | null;

function str(body: Body, field: string): string | undefined {
  const value = body?.[field];
  return typeof value === 'string' ? value : undefined;
}

function bool(body: Body, field: string): boolean | undefined {
  const value = body?.[field];
  return typeof value === 'boolean' ? value : undefined;
}

export function routeRest(
  store: Store,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: Body,
  host: string,
): RestResult {
  const segments = pathname.split('/').filter((part) => part !== '');
  // pathname always starts with /api/v3 here.
  const rest = segments.slice(2);

  // ---- top level ---------------------------------------------------------
  if (rest.length === 0) {
    if (method === 'GET') {
      return ok(
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
        },
        200,
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return err(404, 'Not Found');
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method === 'GET') return ok({ installed_version: '1.0.0' });
    return err(404, 'Not Found');
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') {
      return ok({
        login: store.viewerLogin,
        id: 1000,
        node_id: globalId('User', 1000),
        type: 'User',
        name: store.viewerLogin,
        email: `${store.viewerLogin}@example.invalid`,
        html_url: `https://github.com/${store.viewerLogin}`,
      });
    }
    return err(404, 'Not Found');
  }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = str(body, 'name');
      if (!name) return err(422, 'name is required');
      const repo = store.createRepo(name, bool(body, 'private') ?? false, str(body, 'description') ?? '');
      if (!repo) return err(422, `Repository ${name} already exists`);
      return ok(repoJson(store, repo), 201);
    }
    if (method === 'GET') {
      const { page, perPage } = pageParams(query);
      const repos = store.listRepos();
      const link = linkHeader(host, pathname, query, page, perPage, repos.length);
      return ok(
        paginate(repos, page, perPage).map((repo) => repoJson(store, repo)),
        200,
        link ? { link } : undefined,
      );
    }
    return err(404, 'Not Found');
  }

  // ---- /repos/{owner}/{name}/... ----------------------------------------
  if (rest[0] !== 'repos' || rest.length < 3) return err(404, 'Not Found');
  const owner = decodeURIComponent(rest[1] as string);
  const name = decodeURIComponent(rest[2] as string);
  const repo = store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') return ok(repoJson(store, repo));
    if (method === 'PATCH') {
      const description = str(body, 'description');
      if (description !== undefined) repo.description = description;
      const isPrivate = bool(body, 'private');
      if (isPrivate !== undefined) repo.private = isPrivate;
      return ok(repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: store.refCommit(repo, `refs/heads/${branch}`) ?? '' }, protected: false }));
      return ok(branches);
    }
    if (tail.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(tail[1] as string);
      const sha = store.refCommit(repo, `refs/heads/${branch}`);
      if (!sha) return err(404, 'Not Found');
      return ok({ name: branch, commit: { sha }, protected: false });
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const commits = store.listCommits(repo, ref);
      const out: unknown[] = [];
      for (const oid of commits) {
        const entry = commitJson(store, repo, oid);
        if (entry) out.push(entry);
      }
      return ok(out);
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const ref = str(body, 'ref');
      const sha = str(body, 'sha');
      if (!ref || !sha || !isOid(sha)) return err(422, 'ref and sha are required');
      if (!store.createRef(repo, ref, sha)) return err(422, 'ref already exists or sha is unknown');
      return ok({ ref, node_id: globalId('Ref', repo.dbId, ref), object: { sha: sha.toLowerCase(), type: 'commit' } }, 201);
    }
    if (method === 'GET' && tail.length >= 4 && tail[2] === 'heads') {
      const branch = decodeURIComponent(tail.slice(3).join('/'));
      const sha = store.refCommit(repo, `refs/heads/${branch}`);
      if (!sha) return err(404, 'Not Found');
      return ok({
        ref: `refs/heads/${branch}`,
        node_id: globalId('Ref', repo.dbId, `refs/heads/${branch}`),
        object: { sha, type: 'commit' },
        sha,
        commit: { sha },
      });
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'contents') {
    const path = tail.slice(1).map((part) => decodeURIComponent(part)).join('/');
    if (method === 'GET') {
      const ref = query.get('ref') ?? undefined;
      const read = store.readContent(repo, ref, path);
      if (!read) return err(404, 'Not Found');
      if (read.kind === 'file') {
        return ok({
          type: 'file',
          encoding: 'base64',
          content: read.data.toString('base64'),
          sha: read.oid,
          size: read.data.length,
          name: path.split('/').pop() ?? path,
          path,
        });
      }
      return ok(read.entries.map((entry) => ({ ...entry, size: 0 })));
    }
    if (method === 'PUT') {
      const message = str(body, 'message') ?? '';
      const contentB64 = str(body, 'content');
      if (contentB64 === undefined) return err(422, 'content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return err(422, 'content is not valid base64');
      }
      const branch = str(body, 'branch');
      const sha = str(body, 'sha');
      const existing = store.readContent(repo, branch, path);
      if (existing?.kind === 'file') {
        if (!sha) return err(409, 'sha is required to update a file');
        if (sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current file');
      }
      const result = store.putContent(repo, branch, path, content, message);
      if ('error' in result) return err(404, 'Not Found');
      return ok(
        {
          content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha, message },
        },
        result.created ? 201 : 200,
      );
    }
    if (method === 'DELETE') {
      const message = str(body, 'message') ?? '';
      const sha = str(body, 'sha');
      const existing = store.readContent(repo, undefined, path);
      if (!existing || existing.kind !== 'file') return err(404, 'Not Found');
      if (sha && sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current file');
      const result = store.deleteContent(repo, undefined, path, message);
      if ('error' in result) return err(404, 'Not Found');
      return ok({ commit: { sha: result.commitSha, message }, content: null });
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const labelName = str(body, 'name');
      if (!labelName) return err(422, 'name is required');
      if (repo.labels.has(labelName)) return err(422, 'label already exists');
      const color = str(body, 'color') ?? 'ededed';
      repo.labels.set(labelName, { name: labelName, color });
      return ok({ name: labelName, color }, 201);
    }
    if (method === 'GET' && tail.length === 1) {
      return ok([...repo.labels.values()]);
    }
    return err(404, 'Not Found');
  }

  return routeRestPart2(store, repo, tail, method, query, body, host, pathname);
}

// The issues / pulls routes live below so this file stays in two messages.
export function routeRestPart2(
  store: Store,
  repo: Repo,
  tail: string[],
  method: string,
  query: URLSearchParams,
  body: Body,
  host: string,
  pathname: string,
): RestResult {
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const title = str(body, 'title');
        if (!title) return err(422, 'title is required');
        const labelsRaw = body?.labels;
        const labels: string[] = Array.isArray(labelsRaw) ? labelsRaw.filter((entry): entry is string => typeof entry === 'string') : [];
        const created = store.createIssue(repo, title, str(body, 'body') ?? '', labels);
        if ('error' in created) return err(422, `label ${created.label} does not exist`);
        return ok(issueJson(store, repo, created), 201);
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'asc';
        let issues = [...repo.issues];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        if (sort === 'created' && direction === 'desc') issues.reverse();
        const { page, perPage } = pageParams(query);
        const link = linkHeader(host, pathname, query, page, perPage, issues.length);
        return ok(
          paginate(issues, page, perPage).map((issue) => issueJson(store, repo, issue)),
          200,
          link ? { link } : undefined,
        );
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(tail[1] as string, 10);
    if (!Number.isFinite(number)) return err(404, 'Not Found');
    const issue = store.getIssue(repo, number);
    if (!issue) return err(404, 'Not Found');
    if (tail.length === 2) {
      if (method === 'GET') return ok(issueJson(store, repo, issue));
      if (method === 'PATCH') {
        const state = str(body, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = str(body, 'title');
        if (title !== undefined) issue.title = title;
        const issueBody = str(body, 'body');
        if (issueBody !== undefined) issue.body = issueBody;
        return ok(issueJson(store, repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (tail[2] === 'comments') {
      if (method === 'POST' && tail.length === 3) {
        const commentBody = str(body, 'body');
        if (commentBody === undefined) return err(422, 'body is required');
        const comment = store.addComment(repo, issue, commentBody);
        return ok({ id: comment.id, node_id: comment.globalId, body: comment.body, user: { login: repo.owner, type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO }, 201);
      }
      if (method === 'GET' && tail.length === 3) {
        return ok(
          issue.comments.map((comment) => ({
            id: comment.id,
            node_id: comment.globalId,
            body: comment.body,
            user: { login: repo.owner, type: 'User' },
            created_at: FIXED_ISO,
            updated_at: FIXED_ISO,
          })),
        );
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const title = str(body, 'title');
        const head = str(body, 'head');
        const base = str(body, 'base');
        if (!title || !head || !base) return err(422, 'title, head and base are required');
        const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
        if (existing) return err(422, 'a pull request already exists for this head and base');
        const created = store.createPull(repo, head, base, title, str(body, 'body') ?? '');
        if ('error' in created) return err(422, 'head or base branch does not exist');
        return ok(pullJson(store, repo, created), 201);
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        const { page, perPage } = pageParams(query);
        const link = linkHeader(host, pathname, query, page, perPage, pulls.length);
        return ok(
          paginate(pulls, page, perPage).map((pull) => pullJson(store, repo, pull)),
          200,
          link ? { link } : undefined,
        );
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(tail[1] as string, 10);
    if (!Number.isFinite(number)) return err(404, 'Not Found');
    const pull = store.getPull(repo, number);
    if (!pull) return err(404, 'Not Found');
    if (tail.length === 2) {
      if (method === 'GET') return ok(pullJson(store, repo, pull));
      return err(404, 'Not Found');
    }
    if (tail[2] === 'files' && method === 'GET' && tail.length === 3) {
      const files = store.pullFiles(repo, pull);
      return ok(
        files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
        })),
      );
    }
    if (tail[2] === 'merge' && method === 'PUT' && tail.length === 3) {
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) {
        if (merged.error === 'conflict') return err(405, 'merge conflict');
        return err(405, 'pull request is not open');
      }
      return ok({ sha: merged.sha, merged: true, message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}` });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

export { lineCount };
