// Git smart-HTTP: pkt-lines, packfiles, upload-pack (v2 and v0) and
// receive-pack (v0). The server stores pushed object bytes verbatim and
// returns them verbatim; packs it sends carry plain objects only (no
// deltas), which the client's reader accepts. Incoming packs are parsed
// fully, including OFS/REF deltas, with the trailer SHA-1 verified.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export const PKT_MAX = 65_520;

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const pktFlush: Buffer = Buffer.from('0000', 'ascii');
export const pktDelim: Buffer = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktPacket {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer into pkt-line packets (request bodies are small). */
export function decodePktLines(buf: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

function pktLinesText(buf: Buffer): string[] {
  return decodePktLines(buf)
    .filter((packet) => packet.kind === 'data')
    .map((packet) => packet.payload.toString('utf8'));
}

// ---------------------------------------------------------------- packs

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  bytes.push((PACK_TYPE_CODES[type] << 4) | (remaining & 0x0f));
  remaining >>= 4;
  while (remaining > 0) {
    bytes.push(remaining & 0x7f);
    remaining >>= 7;
  }
  for (let i = 0; i < bytes.length - 1; i += 1) bytes[i] = (bytes[i] as number) | 0x80;
  return Buffer.from(bytes);
}

/** A packfile of plain objects: PACK, version 2, entries, SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  if (pack.length < 20) return { ok: false, actual: '', expected: '' };
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: actual === expected, actual, expected };
}

/** Inflate one zlib stream starting at `pos`; returns its bytes and the next offset. */
function inflateAt(buf: Buffer, pos: number): { data: Buffer; next: number } {
  const data = inflateSync(buf.subarray(pos));
  // The deflated form is at most the inflated size plus a small stored-block
  // overhead; binary-search the minimal prefix that inflates to the same bytes.
  let lo = pos + 1;
  let hi = Math.min(buf.length, pos + data.length + 1_024);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const trial = inflateSync(buf.subarray(pos, mid));
      if (trial.equals(data)) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return { data, next: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) offset = delta[pos] as number, pos += 1;
      if ((op & 0x02) !== 0) offset |= (delta[pos] as number) << 8, pos += 1;
      if ((op & 0x04) !== 0) offset |= (delta[pos] as number) << 16, pos += 1;
      if ((op & 0x08) !== 0) offset |= (delta[pos] as number) << 24, pos += 1;
      if ((op & 0x10) !== 0) size = delta[pos] as number, pos += 1;
      if ((op & 0x20) !== 0) size |= (delta[pos] as number) << 8, pos += 1;
      if ((op & 0x40) !== 0) size |= (delta[pos] as number) << 16, pos += 1;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  declaredCount: number;
}

/** Parse a packfile, resolving deltas against earlier entries or the store. */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): ReadPackResult {
  const checksum = verifyPackChecksum(pack);
  if (!checksum.ok) throw new Error('pack trailer does not match its bytes');
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let pos = 12;
  const end = pack.length - 20;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = pos;
    let byte = pack[pos] as number;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (typeCode === 6) {
      // OFS_DELTA: variable-length negative offset.
      byte = pack[pos] as number;
      pos += 1;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - offset;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateAt(pack, pos);
    pos = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    let object: GitObject;
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (baseOffset >= 0) base = byOffset.get(baseOffset);
      else if (baseOid) base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (!base) throw new Error('delta base not found');
      const data = applyDelta(base.data, inflated.data);
      object = { type: base.type, data };
    } else {
      const type = PACK_TYPES[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      object = { type, data: inflated.data };
    }
    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(entryOffset, object);
  }
  if (pos !== end) throw new Error('pack has trailing bytes before the trailer');
  return { objects, deltaCount, declaredCount };
}

/** Sideband-wrap bytes as band-1 pkt-lines (each packet at most 65520 bytes). */
export function sideband(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const chunkSize = PKT_MAX - 4 - 1;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + chunkSize));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- advertisements

const UPLOAD_CAPS = 'side-band-64k shallow thin-pack ofs-delta multi_ack_detailed agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';

interface RefLine {
  oid: string;
  name: string;
}

function sortedRefs(repo: Repo): RefLine[] {
  const refs: RefLine[] = [];
  for (const [name, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    refs.push({ oid, name });
  }
  return refs;
}

/** The v0 ref advertisement for a service, with the service preamble. The
 *  preamble is the `# service=` line followed at once by a flush packet:
 *  git's smart-HTTP reader treats everything up to the first flush as
 *  preamble metadata, so without that flush it would swallow the ref lines. */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.refs.get('refs/heads/main');
    const lines: string[] = [];
    if (headTip) lines.push(`${headTip} HEAD`);
    for (const ref of refs) lines.push(`${ref.oid} ${ref.name}`);
    // Peeled tags follow their tag line.
    const expanded: string[] = [];
    for (const line of lines) {
      expanded.push(line);
      const name = line.slice(41);
      if (name.startsWith('refs/tags/')) {
        const object = repo.objects.get(line.slice(0, 40).toLowerCase());
        if (object?.type === 'tag') {
          expanded.push(`${parseTag(object.data).object} ${name}^{}`);
        }
      }
    }
    expanded.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement. */
export function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine('agent=forge/1.0\n'),
    pktFlush,
  ]);
}

// ---------------------------------------------------------------- ls-refs

export interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  const includeHead = args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (includeHead) {
    if (mainTip) {
      parts.push(pktLine(`${mainTip} HEAD symref-target:refs/heads/main\n`));
    } else if (args.unborn) {
      parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  }
  const include = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  for (const ref of sortedRefs(repo)) {
    if (!include(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const object = repo.objects.get(ref.oid.toLowerCase());
      if (object?.type === 'tag') {
        // Peel to the commit the tag (chain) names.
        let current = parseTag(object.data).object.toLowerCase();
        for (let step = 0; step < 16; step += 1) {
          const next = repo.objects.get(current);
          if (!next || next.type !== 'tag') break;
          current = parseTag(next.data).object.toLowerCase();
        }
        line += ` peeled:${current}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenRelative?: boolean;
}

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/** Which objects a fetch sends, and the new shallow boundary. */
export function planFetch(store: Store, repo: Repo, args: FetchArgs): FetchPlan {
  const wants = args.wants.filter(isOid);
  const haves = args.haves.filter(isOid);
  const clientShallow = new Set(args.shallow.filter(isOid).map((oid) => oid.toLowerCase()));
  let depth = args.depth ?? 0;
  if (args.deepenRelative === true && depth > 0 && clientShallow.size > 0) {
    // `deepen <n>` with `deepen-relative` (real git's `--deepen=N`): n is
    // relative to the client's current shallow boundary, not absolute. The
    // boundary sits at some generation below each want; the new absolute
    // depth is the shallowest such generation plus n.
    let boundaryGen = Number.POSITIVE_INFINITY;
    for (const want of wants) {
      const queue: Array<{ oid: string; generation: number }> = [{ oid: want.toLowerCase(), generation: 1 }];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift() as { oid: string; generation: number };
        if (seen.has(current.oid)) continue;
        seen.add(current.oid);
        if (clientShallow.has(current.oid)) {
          boundaryGen = Math.min(boundaryGen, current.generation);
          continue;
        }
        const object = repo.objects.get(current.oid);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) {
          queue.push({ oid: parent.toLowerCase(), generation: current.generation + 1 });
        }
      }
    }
    if (Number.isFinite(boundaryGen)) depth = boundaryGen + depth;
  }

  // Commits within `depth` generations of the wants (0 = unlimited).
  const wantCommits = store.reachableCommits(repo, wants, depth);
  // Commits the client already holds: reachable from its haves without
  // descending below its shallow boundary.
  const haveCommits = new Set<string>();
  {
    const queue: string[] = haves.map((oid) => oid.toLowerCase());
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (haveCommits.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      haveCommits.add(oid);
      if (clientShallow.has(oid)) continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent.toLowerCase());
    }
  }
  const sendCommits = [...wantCommits].filter((oid) => !haveCommits.has(oid));
  // Objects: the closure of the sent commits, minus anything the client holds.
  // The held set is the tree closure of exactly the held commits: a shallow
  // boundary commit's parents are NOT held, even though they are reachable
  // from it, so reachableObjects(..., 0) here would wrongly filter out the
  // very objects a deepen is supposed to deliver.
  const haveObjects = store.commitTreeObjects(repo, [...haveCommits]);
  const sendObjects = new Map<string, GitObject>();
  for (const oid of store.commitTreeObjects(repo, sendCommits)) {
    if (haveObjects.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) sendObjects.set(oid, object);
  }
  // Tags among the wants that the client does not hold.
  for (const want of wants) {
    const object = repo.objects.get(want.toLowerCase());
    if (object?.type === 'tag' && !haveObjects.has(want.toLowerCase())) {
      sendObjects.set(want.toLowerCase(), object);
      const peeled = store.peel(repo, want);
      for (const oid of store.reachableObjects(repo, [peeled], 0)) {
        if (haveObjects.has(oid)) continue;
        const entry = repo.objects.get(oid);
        if (entry) sendObjects.set(oid, entry);
      }
    }
  }

  // Shallow-info: the new boundary is the deepest generation the fetch
  // included; an old boundary whose parent is now included is unshallowed.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth > 0) {
    const generations = new Map<string, number>();
    const queue: Array<{ oid: string; generation: number }> = wants
      .filter(isOid)
      .map((oid) => ({ oid: oid.toLowerCase(), generation: 1 }));
    while (queue.length > 0) {
      const current = queue.shift() as { oid: string; generation: number };
      if (generations.has(current.oid)) continue;
      generations.set(current.oid, current.generation);
      if (current.generation >= depth) continue;
      const object = repo.objects.get(current.oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        queue.push({ oid: parent.toLowerCase(), generation: current.generation + 1 });
      }
    }
    for (const [oid, generation] of generations) {
      if (generation !== depth) continue;
      if (!sendCommits.includes(oid) && !haveCommits.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object?.type !== 'commit') continue;
      if (parseCommit(object.data).parents.length > 0) shallow.push(oid);
    }
    for (const boundary of clientShallow) {
      if (wantCommits.has(boundary)) {
        const object = repo.objects.get(boundary);
        if (object?.type === 'commit') {
          const parents = parseCommit(object.data).parents.map((p) => p.toLowerCase());
          if (parents.some((parent) => wantCommits.has(parent))) unshallow.push(boundary);
        }
      }
    }
  } else {
    for (const boundary of clientShallow) {
      if (wantCommits.has(boundary)) {
        const object = repo.objects.get(boundary);
        if (object?.type === 'commit') {
          const parents = parseCommit(object.data).parents.map((p) => p.toLowerCase());
          if (parents.some((parent) => wantCommits.has(parent))) unshallow.push(boundary);
        }
      }
    }
  }

  const acks: string[] = [];
  for (const have of haves) {
    if (repo.objects.has(have.toLowerCase())) acks.push(have.toLowerCase());
  }
  return { objects: sendObjects, shallow, unshallow, acks };
}

/** The v2 fetch response: acknowledgments, shallow-info, packfile sections.
 *  The acknowledgments section is sent only when the client sent `have`
 *  lines: a client with nothing to negotiate skips straight to the packfile
 *  section, and an unexpected acknowledgments header makes it die. The
 *  packfile section is always sent when anything was wanted, even when
 *  nothing is new (an empty pack), so the client never looks for a section
 *  that is not there. */
export function fetchResponseV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(store, repo, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    // Single-round stateless fetch: negotiation is complete, so the server
    // declares itself ready to send the packfile. Real git requires this
    // line before any later section; without it a deepen/fetch fails with
    // "expected no other sections to be sent after no 'ready'".
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim);
  }
  if (args.wants.length > 0) {
    const pack = writePack([...plan.objects.values()]);
    parts.push(pktLine('packfile\n'));
    parts.push(sideband(pack, 1));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

/** The v0 fetch response: NAK/ACK lines, shallow lines, then the sideband pack.
 *  The pack is always sent when anything was wanted, even when nothing is
 *  new (an empty pack). */
export function fetchResponseV0(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(store, repo, args);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (args.wants.length > 0) {
    const pack = writePack([...plan.objects.values()]);
    parts.push(sideband(pack, 1));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- request parsing

/** Split a v2 command body into the pre-delim lines and the argument lines. */
function splitV2(body: Buffer): { head: string[]; args: string[] } {
  const packets = decodePktLines(body);
  const head: string[] = [];
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (afterDelim) args.push(line);
    else head.push(line);
  }
  return { head, args };
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const depth = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) out.depth = depth;
    } else if (arg === 'deepen-relative') out.deepenRelative = true;
  }
  return out;
}

/** Parse a v0 upload-pack body: wants section, then haves section. */
function parseV0Upload(body: Buffer): FetchArgs {
  const packets = decodePktLines(body);
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) out.wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const depth = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(depth) && depth > 0) out.depth = depth;
      } else if (line === 'deepen-relative') out.deepenRelative = true;
    } else if (line.startsWith('have ')) {
      out.haves.push(line.slice(5).trim());
    }
  }
  return out;
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack body: command pkt-lines, a flush, then the pack. */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const packets = decodePktLines(body);
  const commands: PushCommand[] = [];
  let offset = 0;
  let sawFlush = false;
  // Walk the raw buffer: pkt-lines until the first flush packet, then the pack.
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(head, 16);
    if (!Number.isFinite(length) || length < 0) break;
    if (length === 0) {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const text = nul >= 0 ? line.slice(0, nul) : line;
    const parts = text.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
    offset += length;
  }
  void packets;
  void sawFlush;
  return { commands, pack: body.subarray(offset) };
}

// ---------------------------------------------------------------- receive-pack

function isAncestor(store: Store, repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor.toLowerCase() === tip.toLowerCase()) return true;
  return store.reachableCommits(repo, [tip], 0).has(ancestor.toLowerCase());
}

/** Apply a receive-pack: unpack, validate each ref update, report per ref. */
export function receivePackResponse(store: Store, repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = parseReceivePack(body);
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (commands.some((command) => command.newOid !== ZERO_OID)) {
    try {
      const read = readPack(pack, (oid) => repo.objects.get(oid.toLowerCase()));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (!unpackOk) {
    report.push(`unpack ${unpackDetail}\n`);
    for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
  } else {
    report.push('unpack ok\n');
    for (const command of commands) {
      const ref = command.ref;
      const current = repo.refs.get(ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (!current) {
          report.push(`ng ${ref} cannot delete a ref that does not exist\n`);
        } else if (current.toLowerCase() !== command.oldOid.toLowerCase()) {
          report.push(`ng ${ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(ref);
          report.push(`ok ${ref}\n`);
        }
        continue;
      }
      const target = repo.objects.get(command.newOid.toLowerCase());
      if (!target) {
        report.push(`ng ${ref} object not found\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current) {
          report.push(`ng ${ref} already exists\n`);
        } else {
          repo.refs.set(ref, command.newOid.toLowerCase());
          report.push(`ok ${ref}\n`);
        }
        continue;
      }
      if (!current) {
        report.push(`ng ${ref} non-fast-forward\n`);
        continue;
      }
      if (current.toLowerCase() !== command.oldOid.toLowerCase()) {
        report.push(`ng ${ref} non-fast-forward\n`);
        continue;
      }
      if (!isAncestor(store, repo, command.oldOid, command.newOid)) {
        report.push(`ng ${ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(ref, command.newOid.toLowerCase());
      report.push(`ok ${ref}\n`);
    }
  }
  const reportBytes = Buffer.concat([...report.map((line) => pktLine(line)), pktFlush]);
  return Buffer.concat([sideband(reportBytes, 1), pktFlush]);
}

// ---------------------------------------------------------------- entry points

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFoundJson(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, repo: Repo | undefined, service: string, gitProtocolV2: boolean): GitResponse {
  if (!repo) return notFoundJson();
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertiseV0(repo, 'git-receive-pack') };
  }
  if (service === 'git-upload-pack') {
    if (gitProtocolV2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV0(repo, 'git-upload-pack') };
  }
  return notFoundJson();
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(store: Store, repo: Repo | undefined, body: Buffer, gitProtocolV2: boolean): GitResponse {
  if (!repo) return notFoundJson();
  try {
    if (gitProtocolV2) {
      const { head, args } = splitV2(body);
      const command = head.find((line) => line.startsWith('command='))?.slice('command='.length);
      if (command === 'ls-refs') {
        const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (const arg of args) {
          if (arg === 'peel') lsArgs.peel = true;
          else if (arg === 'symrefs') lsArgs.symrefs = true;
          else if (arg === 'unborn') lsArgs.unborn = true;
          else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
        }
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, lsArgs) };
      }
      if (command === 'fetch') {
        const fetchArgs = parseFetchArgs(args);
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV2(store, repo, fetchArgs) };
      }
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'unknown command' }), 'utf8') };
    }
    const fetchArgs = parseV0Upload(body);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV0(store, repo, fetchArgs) };
  } catch (err) {
    return {
      status: 400,
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(JSON.stringify({ message: err instanceof Error ? err.message : 'bad request' }), 'utf8'),
    };
  }
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: Store, repo: Repo | undefined, body: Buffer): GitResponse {
  if (!repo) return notFoundJson();
  try {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: receivePackResponse(store, repo, body) };
  } catch (err) {
    return {
      status: 400,
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(JSON.stringify({ message: err instanceof Error ? err.message : 'bad request' }), 'utf8'),
    };
  }
}
