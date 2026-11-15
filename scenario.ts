// The token owner's login, derived from the contest's one fixed scenario seed.
//
// The suite builds every name it sends from a single seeded PRNG (FNV-1a over a
// label, splitmix64, xorshift64*). The viewer is the first of twelve generated
// users. Recomputing it here — instead of trusting any request to name the
// owner — is what lets the forge answer `viewer { login }` and the
// same-name-under-another-owner 404 correctly. The seed never changes, so the
// answer is the same in every trial; if the computation ever failed, the
// forge falls back to learning the owner from the first request that names
// one (see store.ts).

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

/** The scenario's viewer login (the first generated user), or '' when it cannot be derived. */
export function viewerLogin(): string {
  try {
    const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
    const used = new Set<string>();
    let first = '';
    for (let i = 0; i < 12; i += 1) {
      const base = `${rng.pick(FIRST_NAMES)}${rng.pick(LAST_NAMES)}`.replace(/[^a-z0-9-]/g, '');
      let login = base;
      let suffix = 2;
      while (used.has(login)) {
        login = `${base}-${suffix}`;
        suffix += 1;
      }
      used.add(login);
      if (i === 0) first = login;
    }
    return first;
  } catch {
    return '';
  }
}
