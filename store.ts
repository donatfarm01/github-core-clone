// The forge's in-memory store: git objects, repositories, issues, pull
// requests, and the merge logic. Everything lives in process memory — a
// trial starts with a fresh, empty forge, and the suite seeds its own data
// through the entry's own surfaces. No clock and no unseeded randomness in
// request handling: server-made commits carry one fixed timestamp, so a
// replay of the same requests reaches byte-identical state.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** The one timestamp every server-made commit carries (2025-01-01T00:00:00Z). */
export const FIXED_EPOCH = 1_735_689_600;
export const FIXED_ISO = '2025-01-01T00:00:00Z';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/** Parse a commit object into its headers and message. */
export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
} {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
} {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build a tree object: entries sorted git-style (a directory sorts as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit object. */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

/** Build an annotated tag object. */
export function buildTag(input: {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}): Buffer {
  return Buffer.from(
    `object ${input.object}\ntype ${input.type}\ntag ${input.tag}\ntagger ${input.tagger}\n\n${input.message}`,
    'utf8',
  );
}

/** The line count of a text file (a trailing newline does not add a line). */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** Added/removed line counts between two versions, by longest-common-subsequence on lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n').filter((_, i, a) => !(i === a.length - 1 && a[i] === ''));
  const newLines = newText === '' ? [] : newText.split('\n').filter((_, i, a) => !(i === a.length - 1 && a[i] === ''));
  const n = oldLines.length;
  const m = newLines.length;
  // LCS table; files here are small (scenario blobs are a few KiB at most).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const common = dp[0]![0] ?? 0;
  return { additions: m - common, deletions: n - common };
}

/** An opaque Relay-style global id: base64url of a typed key. */
export function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
}

export interface Issue {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  dbId: number;
  globalId: string;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
}

export interface FileEntry {
  oid: string;
  mode: string;
}

const DEFAULT_BRANCH = 'main';

export class Store {
  readonly viewerLogin: string;
  /** Epoch seconds stamped on commits the server itself creates. The trial
   *  clock (MAKEFUN_TRIAL_NOW) when the environment sets it, else the fixed
   *  scenario epoch — either way constant inside one trial, so a replay
   *  produces the same commit bytes. */
  readonly serverEpoch: number;
  private reposByKey = new Map<string, Repo>();
  private reposInOrder: Repo[] = [];
  private nextDbId = 1;
  private nextEntityId = 1;
  private nextCommentId = 1;
  private nextSeq = 1;
  /** globalId -> { kind, repoKey, number } for node(id:) resolution. */
  readonly globalIds = new Map<string, { kind: string; repoKey: string; number: number }>();

  constructor(viewerLogin: string, serverEpoch: number = FIXED_EPOCH) {
    this.viewerLogin = viewerLogin;
    this.serverEpoch = serverEpoch;
  }

  private key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  serverIdentity(): string {
    return `${this.viewerLogin} <${this.viewerLogin}@example.invalid>`;
  }

  // ---------------------------------------------------------------- repos

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.key(this.viewerLogin, name);
    if (this.reposByKey.has(key)) return null;
    const dbId = this.nextDbId;
    this.nextDbId += 1;
    const repo: Repo = {
      dbId,
      globalId: globalId('Repository', dbId),
      name,
      owner: this.viewerLogin,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.nextSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
    };
    this.nextSeq += 1;
    this.reposByKey.set(key, repo);
    this.reposInOrder.push(repo);
    this.globalIds.set(repo.globalId, { kind: 'Repository', repoKey: key, number: dbId });
    return repo;
  }

  /** A repository only exists under the token owner's login; any other owner is a 404. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner.toLowerCase() !== this.viewerLogin.toLowerCase()) return undefined;
    return this.reposByKey.get(this.key(owner, name));
  }

  getRepoByKey(key: string): Repo | undefined {
    return this.reposByKey.get(key);
  }

  repoKeyOf(repo: Repo): string {
    return this.key(repo.owner, repo.name);
  }

  listRepos(): Repo[] {
    return [...this.reposInOrder];
  }

  deleteRepo(repo: Repo): void {
    const key = this.repoKeyOf(repo);
    this.reposByKey.delete(key);
    this.reposInOrder = this.reposInOrder.filter((entry) => entry !== repo);
  }

  // ---------------------------------------------------------------- objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid.toLowerCase());
  }

  /** Commit oids reachable from `tips`, limited to `depth` commit generations (0 = unlimited). */
  reachableCommits(repo: Repo, tips: readonly string[], depth = 0): Set<string> {
    const seen = new Set<string>();
    const queue: Array<{ oid: string; generation: number }> = [];
    for (const tip of tips) {
      if (isOid(tip) && repo.objects.get(tip.toLowerCase())?.type === 'commit') {
        queue.push({ oid: tip.toLowerCase(), generation: 1 });
      }
    }
    while (queue.length > 0) {
      const current = queue.shift() as { oid: string; generation: number };
      if (seen.has(current.oid)) continue;
      if (depth > 0 && current.generation > depth) continue;
      seen.add(current.oid);
      const object = repo.objects.get(current.oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!seen.has(parent.toLowerCase())) queue.push({ oid: parent.toLowerCase(), generation: current.generation + 1 });
      }
    }
    return seen;
  }

  /** Every object reachable from `tips` (commits, their trees and blobs, tags peeled), with a commit depth limit. */
  reachableObjects(repo: Repo, tips: readonly string[], depth = 0): Set<string> {
    const out = new Set<string>();
    const commits = this.reachableCommits(repo, tips, depth);
    const visitTree = (oid: string): void => {
      if (out.has(oid)) return;
      const object = repo.objects.get(oid);
      if (!object) return;
      out.add(oid);
      if (object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') visitTree(entry.oid);
        else if (repo.objects.has(entry.oid)) out.add(entry.oid);
      }
    };
    for (const commitOid of commits) {
      out.add(commitOid);
      const object = repo.objects.get(commitOid);
      if (object) visitTree(parseCommit(object.data).tree);
    }
    // Tags among the tips peel to their target.
    for (const tip of tips) {
      const object = repo.objects.get(tip.toLowerCase());
      if (object?.type === 'tag') {
        const target = parseTag(object.data).object.toLowerCase();
        out.add(tip.toLowerCase());
        if (repo.objects.get(target)?.type === 'commit') {
          for (const oid of this.reachableObjects(repo, [target], depth)) out.add(oid);
        } else if (repo.objects.has(target)) out.add(target);
      }
    }
    return out;
  }

  /** Peel a tag (recursively) to the commit or object it names. */
  peel(repo: Repo, oid: string): string {
    let current = oid.toLowerCase();
    for (let step = 0; step < 16; step += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      current = parseTag(object.data).object.toLowerCase();
    }
    return current;
  }

  /** A ref's target commit, peeling tags; undefined when the ref is absent or unborn. */
  refCommit(repo: Repo, refName: string): string | undefined {
    const oid = repo.refs.get(refName);
    if (!oid) return undefined;
    return this.peel(repo, oid);
  }

  /** Resolve a branch name, full ref, or oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isOid(ref)) {
      const object = repo.objects.get(ref.toLowerCase());
      if (object?.type === 'commit') return ref.toLowerCase();
      if (object?.type === 'tag') return this.peel(repo, ref);
      return undefined;
    }
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      return oid ? this.peel(repo, oid) : undefined;
    }
    const oid = repo.refs.get(`refs/heads/${ref}`);
    return oid ? this.peel(repo, oid) : undefined;
  }

  /** Commits reachable from a ref, newest first (parent-chain order). */
  listCommits(repo: Repo, ref: string): string[] {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent.toLowerCase());
    }
    return out;
  }

  /** The flat file map of a commit: path -> { oid, mode }. */
  fileMapOf(repo: Repo, commitOid: string): Map<string, FileEntry> {
    const out = new Map<string, FileEntry>();
    const object = repo.objects.get(commitOid.toLowerCase());
    if (!object || object.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(parseCommit(object.data).tree, '');
    return out;
  }

  /** Build a tree object from a flat file map, returning the tree oid. */
  treeFromFileMap(repo: Repo, files: Map<string, FileEntry>): string {
    interface Node {
      files: Map<string, FileEntry>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of [...files.entries()].sort()) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The nearest common ancestor of two commits, or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Map<string, number>();
    const queueA: Array<{ oid: string; depth: number }> = [{ oid: a.toLowerCase(), depth: 0 }];
    while (queueA.length > 0) {
      const current = queueA.shift() as { oid: string; depth: number };
      if (ancestorsA.has(current.oid)) continue;
      ancestorsA.set(current.oid, current.depth);
      const object = repo.objects.get(current.oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        queueA.push({ oid: parent.toLowerCase(), depth: current.depth + 1 });
      }
    }
    const queueB: Array<{ oid: string; depth: number }> = [{ oid: b.toLowerCase(), depth: 0 }];
    const seenB = new Set<string>();
    let best: string | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;
    while (queueB.length > 0) {
      const current = queueB.shift() as { oid: string; depth: number };
      if (seenB.has(current.oid)) continue;
      seenB.add(current.oid);
      const depthA = ancestorsA.get(current.oid);
      if (depthA !== undefined && depthA + current.depth < bestDepth) {
        best = current.oid;
        bestDepth = depthA + current.depth;
      }
      const object = repo.objects.get(current.oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        queueB.push({ oid: parent.toLowerCase(), depth: current.depth + 1 });
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue | { error: 'bad-label'; label: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: 'bad-label', label };
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    const issue: Issue = {
      id,
      globalId: globalId('Issue', repo.dbId, number),
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.nextSeq,
    };
    this.nextSeq += 1;
    repo.issues.push(issue);
    this.globalIds.set(issue.globalId, { kind: 'Issue', repoKey: this.repoKeyOf(repo), number });
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    const comment: Comment = { id, globalId: globalId('IssueComment', repo.dbId, id), body };
    issue.comments.push(comment);
    this.globalIds.set(comment.globalId, { kind: 'IssueComment', repoKey: this.repoKeyOf(repo), number: id });
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  createPull(repo: Repo, headRef: string, baseRef: string, title: string, body: string): Pull | { error: 'no-head' | 'no-base' } {
    const headSha = this.resolveRef(repo, headRef);
    if (!headSha) return { error: 'no-head' };
    const baseSha = this.resolveRef(repo, baseRef);
    if (!baseSha) return { error: 'no-base' };
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    const pull: Pull = {
      id,
      globalId: globalId('PullRequest', repo.dbId, number),
      number,
      title,
      body: body ?? '',
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.nextSeq,
    };
    this.nextSeq += 1;
    repo.pulls.push(pull);
    this.globalIds.set(pull.globalId, { kind: 'PullRequest', repoKey: this.repoKeyOf(repo), number });
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** The changed files of a pull request: merge-base tree vs head tree. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number }> {
    const baseTip = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const ancestor = this.mergeBase(repo, pull.headSha, baseTip);
    const from = ancestor ? this.fileMapOf(repo, ancestor) : new Map<string, FileEntry>();
    const to = this.fileMapOf(repo, pull.headSha);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number }> = [];
    const paths = new Set([...from.keys(), ...to.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = from.get(path);
      const newEntry = to.get(path);
      if (oldEntry && !newEntry) {
        const oldText = repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '';
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lineCount(oldText) });
      } else if (!oldEntry && newEntry) {
        const newText = repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? '';
        out.push({ filename: path, status: 'added', additions: lineCount(newText), deletions: 0 });
      } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
        const oldText = repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? '';
        const diff = lineDiff(oldText, newText);
        out.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions });
      }
    }
    return out;
  }

  /** MERGEABLE / CONFLICTING for a pull request, by the same three-way rule the merge uses. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    if (pull.state !== 'open') return 'CONFLICTING';
    return this.threeWay(repo, pull).conflict === undefined ? 'MERGEABLE' : 'CONFLICTING';
  }

  private threeWay(repo: Repo, pull: Pull): { merged: Map<string, FileEntry>; conflict?: string } {
    const baseTip = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const ancestor = this.mergeBase(repo, pull.headSha, baseTip);
    const from = ancestor ? this.fileMapOf(repo, ancestor) : new Map<string, FileEntry>();
    const head = this.fileMapOf(repo, pull.headSha);
    const base = this.fileMapOf(repo, baseTip);
    const merged = new Map<string, FileEntry>();
    const paths = new Set([...from.keys(), ...head.keys(), ...base.keys()]);
    for (const path of paths) {
      const a = from.get(path);
      const h = head.get(path);
      const b = base.get(path);
      if (h?.oid === a?.oid) {
        if (b) merged.set(path, b);
      } else if (b?.oid === a?.oid) {
        if (h) merged.set(path, h);
      } else if (h?.oid === b?.oid) {
        if (h) merged.set(path, h);
      } else {
        return { merged, conflict: path };
      }
    }
    return { merged };
  }

  /** Squash-merge an open pull request onto its base branch. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: 'conflict' | 'closed' } {
    if (pull.state !== 'open') return { error: 'closed' };
    const result = this.threeWay(repo, pull);
    if (result.conflict !== undefined) return { error: 'conflict' };
    const baseTip = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const treeOid = this.treeFromFileMap(repo, result.merged);
    const identity = this.serverIdentity();
    const stamp = `${this.serverEpoch} +0000`;
    const message = `${pull.title}\n`;
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents: [baseTip],
        author: `${identity} ${stamp}`,
        committer: `${identity} ${stamp}`,
        message,
      }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = commitOid;
    return { sha: commitOid };
  }

  // ---------------------------------------------------------------- contents

  /** Commit one file on a branch (creating the branch from the default tip when needed). */
  putContent(
    repo: Repo,
    branch: string | undefined,
    path: string,
    content: Buffer,
    message: string,
  ): { contentSha: string; commitSha: string; created: boolean } | { error: 'no-branch' | 'no-base' } {
    const targetBranch = branch ?? repo.defaultBranch;
    let tip = this.resolveRef(repo, targetBranch);
    if (!tip) {
      if (branch !== undefined) {
        // A contents write on a missing branch starts it from the default tip.
        const baseTip = this.resolveRef(repo, repo.defaultBranch);
        if (!baseTip) return { error: 'no-base' };
        repo.refs.set(`refs/heads/${targetBranch}`, baseTip);
        tip = baseTip;
      } else if (repo.refs.size === 0) {
        // The repo has no commits at all: the first write is a root commit.
        tip = undefined;
      } else {
        return { error: 'no-branch' };
      }
    }
    const files = tip ? this.fileMapOf(repo, tip) : new Map<string, { oid: string; mode: string }>();
    const created = !files.has(path);
    const blobOid = this.putObject(repo, 'blob', content);
    files.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = this.treeFromFileMap(repo, files);
    const identity = this.serverIdentity();
    const stamp = `${this.serverEpoch} +0000`;
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents: tip ? [tip] : [],
        author: `${identity} ${stamp}`,
        committer: `${identity} ${stamp}`,
        message: message.endsWith('\n') ? message : `${message}\n`,
      }),
    );
    repo.refs.set(`refs/heads/${targetBranch}`, commitOid);
    return { contentSha: blobOid, commitSha: commitOid, created };
  }

  /** Create a branch at a commit (false when it exists or the commit is unknown). */
  createRef(repo: Repo, ref: string, oid: string): boolean {
    if (repo.refs.has(ref)) return false;
    if (!repo.objects.has(oid.toLowerCase())) return false;
    repo.refs.set(ref, oid.toLowerCase());
    return true;
  }

  deleteContent(
    repo: Repo,
    branch: string | undefined,
    path: string,
    message: string,
  ): { commitSha: string } | { error: 'no-branch' | 'not-found' } {
    const targetBranch = branch ?? repo.defaultBranch;
    const tip = this.resolveRef(repo, targetBranch);
    if (!tip) return { error: 'no-branch' };
    const files = this.fileMapOf(repo, tip);
    if (!files.has(path)) return { error: 'not-found' };
    files.delete(path);
    const treeOid = this.treeFromFileMap(repo, files);
    const identity = this.serverIdentity();
    const stamp = `${this.serverEpoch} +0000`;
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents: [tip],
        author: `${identity} ${stamp}`,
        committer: `${identity} ${stamp}`,
        message: message.endsWith('\n') ? message : `${message}\n`,
      }),
    );
    repo.refs.set(`refs/heads/${targetBranch}`, commitOid);
    return { commitSha: commitOid };
  }

  /** Read a file or directory at a ref: null when the ref or path is missing. */
  readContent(
    repo: Repo,
    ref: string | undefined,
    path: string,
  ): { kind: 'file'; data: Buffer; oid: string } | { kind: 'dir'; entries: Array<{ type: string; name: string; path: string; sha: string }> } | null {
    const tip = this.resolveRef(repo, ref ?? repo.defaultBranch);
    if (!tip) return null;
    const files = this.fileMapOf(repo, tip);
    const file = files.get(path);
    if (file) {
      const object = repo.objects.get(file.oid);
      if (!object) return null;
      return { kind: 'file', data: object.data, oid: file.oid };
    }
    // Directory: immediate children of `path`.
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { type: string; sha: string }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.set(rest, { type: 'file', sha: entry.oid });
      } else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) {
          // The subtree's tree oid, for a stable sha.
          const dirFiles = new Map<string, FileEntry>();
          for (const [p, e] of files) {
            if (p.startsWith(`${prefix}${dirName}/`)) dirFiles.set(p.slice(prefix.length + dirName.length + 1), e);
          }
          children.set(dirName, { type: 'dir', sha: this.treeFromFileMap(repo, dirFiles) });
        }
      }
    }
    if (children.size === 0) return null;
    const entries = [...children.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, value]) => ({ type: value.type, name, path: prefix === '' ? name : `${prefix}${name}`, sha: value.sha }));
    return { kind: 'dir', entries };
  }

  /** A server-made root commit on an unborn branch (used only by internal helpers). */
  serverCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const identity = this.serverIdentity();
    const stamp = `${this.serverEpoch} +0000`;
    return this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents,
        author: `${identity} ${stamp}`,
        committer: `${identity} ${stamp}`,
        message: message.endsWith('\n') ? message : `${message}\n`,
      }),
    );
  }
}
