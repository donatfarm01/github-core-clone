# github-core-clone-01 — a GitHub-compatible git forge

One Node 22 process, stdlib only, no git binary, no network beyond the
trial harness. It serves a GitHub-compatible forge from a single in-memory
store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (plus the v0 fallback) and receive-pack v0, with pkt-line framing,
  sideband progress, plain packfiles, and OFS/REF delta reading.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests (including squash merge).
- **GraphQL v4** at `/api/graphql` — the viewer, repository, issue and pull
  request documents gh and github-mcp-server send, plus introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision
  2026-07-28 via `server/discover`, with the legacy `initialize`
  handshake for older clients.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the trial env
(`$MAKEFUN_ENV_URL/register`), then polls `$MAKEFUN_ENV_URL/done` until the
trial ends and exits 0. Without `MAKEFUN_ENV_URL` it just serves locally.

Authentication is `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` on every
route except `/healthz`; a repository belongs to the login the token names,
and the same name under another owner answers 404, never 403.

## Determinism

The store holds no wall-clock time and no unseeded randomness. Commits the
server itself creates (contents writes, squash merges) are stamped with the
trial clock (`MAKEFUN_TRIAL_NOW`) when the environment sets it, else the
fixed scenario epoch 1735689600 — constant inside one trial, so a replayed
trial produces the same state byte-for-byte. The viewer login is derived
from the fixed scenario seed in `scenario.ts`, never from the token.

## Layout

- `main.ts` — lifecycle: bind, register, poll done, exit 0.
- `app.ts` — HTTP server: routing, auth, request ids.
- `store.ts` — the in-memory store: git objects, refs, issues, pulls.
- `git.ts` — pkt-lines, packfiles, upload-pack v2/v0, receive-pack v0.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL v4: parser, resolvers, mutations, introspection.
- `mcp.ts` — MCP tools and the JSON-RPC transport.
- `scenario.ts` — the fixed scenario seed and the viewer login it names.
