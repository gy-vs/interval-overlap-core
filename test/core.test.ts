import { describe, expect, it } from 'vitest';
import { IntervalIndex, type Interval, type QueryStats } from '../src/index.js';

const ids = (items: Array<Interval<unknown>>) => items.map((i) => i.id);

describe('half-open interval semantics', () => {
  it('adjacent intervals do not overlap', () => {
    const idx = new IntervalIndex<number>()
      .add({ id: 'a', start: 0, end: 5, value: 1 })
      .add({ id: 'b', start: 5, end: 10, value: 2 });
    expect(ids(idx.overlap(0, 5))).toEqual(['a']); // b touches only at 5
    expect(ids(idx.overlap(5, 10))).toEqual(['b']); // a ends at 5
    expect(ids(idx.overlap(3, 5))).toEqual(['a']);
    expect(ids(idx.overlap(5, 5))).toEqual([]); // empty query
    expect(ids(idx.overlap(4, 6))).toEqual(['a', 'b']); // crosses the seam
  });

  it('handles equal endpoints across several intervals', () => {
    const idx = new IntervalIndex<number>()
      .add({ id: 'z', start: 1, end: 4, value: 0 })
      .add({ id: 'a', start: 1, end: 4, value: 0 })
      .add({ id: 'm', start: 1, end: 4, value: 0 });
    const hits = idx.overlap(1, 4);
    // Stable order: same start/end, tie-broken by id.
    expect(ids(hits)).toEqual(['a', 'm', 'z']);
  });

  it('handles nested intervals and containment boundaries', () => {
    const idx = new IntervalIndex<number>()
      .add({ id: 'outer', start: 0, end: 100, value: 0 })
      .add({ id: 'inner', start: 10, end: 20, value: 0 })
      .add({ id: 'touching', start: 0, end: 10, value: 0 });
    expect(ids(idx.contains(0, 100)).sort()).toEqual(['inner', 'outer', 'touching']);
    // Half-open: [0,10) does not contain [0,10]? it does contain [0,10) itself.
    expect(ids(idx.contains(0, 10))).toEqual(['touching']);
    expect(ids(idx.contains(5, 25))).toEqual(['inner']);
    expect(ids(idx.contains(0, 20)).sort()).toEqual(['inner', 'touching']);
    expect(ids(idx.overlap(10, 20))).toEqual(['outer', 'inner']);
  });

  it('supports negative coordinates', () => {
    const idx = new IntervalIndex<number>()
      .add({ id: 'neg', start: -10, end: -1, value: 0 })
      .add({ id: 'zero', start: -1, end: 1, value: 0 })
      .add({ id: 'pos', start: 1, end: 9, value: 0 });
    expect(ids(idx.overlap(-10, -1))).toEqual(['neg']); // adjacent to zero
    expect(ids(idx.overlap(-1, 1))).toEqual(['zero']); // adjacent to both
    expect(ids(idx.overlap(-2, 0)).sort()).toEqual(['neg', 'zero']);
    expect(ids(idx.overlap(-5, 2)).sort()).toEqual(['neg', 'pos', 'zero']);
    expect(ids(idx.contains(-10, 10)).sort()).toEqual(['neg', 'pos', 'zero']);
  });

  it('treats empty intervals [x,x) explicitly', () => {
    const idx = new IntervalIndex<number>()
      .add({ id: 'empty5', start: 5, end: 5, value: 0 })
      .add({ id: 'empty0', start: 0, end: 0, value: 0 })
      .add({ id: 'full', start: 0, end: 10, value: 0 });

    // Empty intervals never overlap anything, even at the same coordinate.
    expect(ids(idx.overlap(0, 10))).toEqual(['full']);
    expect(ids(idx.overlap(5, 6))).toEqual(['full']);
    expect(ids(idx.overlap(5, 5))).toEqual([]);
    expect(ids(idx.overlap(0, 0))).toEqual([]);

    // Only an empty query at the same coordinate contains an empty interval.
    expect(ids(idx.contains(0, 0))).toEqual(['empty0']);
    expect(ids(idx.contains(5, 5))).toEqual(['empty5']);
    expect(ids(idx.contains(0, 10))).toEqual(['full']);
    expect(ids(idx.contains(4, 6))).toEqual([]);
  });

  it('rejects inverted ranges', () => {
    expect(() => new IntervalIndex<number>().add({ id: 'x', start: 9, end: 1, value: 0 }))
      .toThrow(/invalid/);
    expect(() => new IntervalIndex<number>().overlap(3, 2)).toThrow(/invalid/);
  });
});

describe('insertion and removal', () => {
  it('replaces an item with the same stable id', () => {
    const v1 = new IntervalIndex<number>().add({ id: 'a', start: 0, end: 1, value: 1 });
    const v2 = v1.add({ id: 'a', start: 2, end: 3, value: 2 });
    expect(v1.size()).toBe(1);
    expect(v2.size()).toBe(1);
    expect(v1.overlap(0, 1).map((i) => i.value)).toEqual([1]);
    expect(v2.overlap(2, 3).map((i) => i.value)).toEqual([2]);
    expect(v2.overlap(0, 1)).toHaveLength(0);
  });

  it('removes the root in trees of every shape', () => {
    // Single node
    let idx = new IntervalIndex<number>().add({ id: 'root', start: 0, end: 1, value: 0 });
    idx = idx.remove('root');
    expect(idx.size()).toBe(0);
    idx.checkInvariants();

    // Root with two children: successor transplant + rebalance.
    idx = new IntervalIndex<number>()
      .add({ id: 'm', start: 0, end: 1, value: 0 })
      .add({ id: 'a', start: 0, end: 1, value: 0 })
      .add({ id: 'z', start: 0, end: 1, value: 0 });
    idx = idx.remove('m');
    idx.checkInvariants();
    expect(ids(idx.contains(0, 1)).sort()).toEqual(['a', 'z']);

    // Missing id is a no-op.
    expect(idx.remove('nope').size()).toBe(2);
  });
});

describe('persistence (copy-on-write)', () => {
  it('old versions are unaffected by later adds and removes', () => {
    const v0 = new IntervalIndex<number>()
      .add({ id: 'a', start: 0, end: 10, value: 1 })
      .add({ id: 'b', start: 5, end: 15, value: 2 });
    const v1 = v0.add({ id: 'c', start: 20, end: 30, value: 3 });
    const v2 = v1.remove('a');

    expect(ids(v0.overlap(0, 30)).sort()).toEqual(['a', 'b']);
    expect(ids(v1.overlap(0, 30)).sort()).toEqual(['a', 'b', 'c']);
    expect(ids(v2.overlap(0, 30)).sort()).toEqual(['b', 'c']);

    v0.checkInvariants();
    v1.checkInvariants();
    v2.checkInvariants();

    // Shared subtrees: pick b by id; its node object is reused across versions
    // because the add/remove paths copy only the nodes they touch.
    const bFromV0 = v0.overlap(0, 30).find((i) => i.id === 'b')!;
    const bFromV2 = v2.overlap(0, 30).find((i) => i.id === 'b')!;
    expect(bFromV0).toBe(bFromV2);
  });
});

describe('rotations keep the augmentation correct', () => {
  it('exercises left, right, left-right and right-left rotations', () => {
    // Descending ids force right rotations (left-heavy).
    let idx = new IntervalIndex<number>();
    for (const id of ['d', 'c', 'b', 'a']) {
      idx = idx.add({ id, start: id.charCodeAt(0), end: id.charCodeAt(0) + 2, value: 0 });
    }
    idx.checkInvariants();
    expect(ids(idx.overlap(0, 200))).toEqual(['a', 'b', 'c', 'd']);

    // Ascending ids force left rotations (right-heavy).
    idx = new IntervalIndex<number>();
    for (const id of ['a', 'b', 'c', 'd']) {
      idx = idx.add({ id, start: id.charCodeAt(0), end: id.charCodeAt(0) + 2, value: 0 });
    }
    idx.checkInvariants();
    expect(ids(idx.overlap(0, 200))).toEqual(['a', 'b', 'c', 'd']);

    // Patterns chosen to trigger double rotations.
    const lr = ['c', 'a', 'b']; // left subtree right-heavy -> left-right
    let t = new IntervalIndex<number>();
    for (const id of lr) t = t.add({ id, start: 0, end: 1, value: 0 });
    t.checkInvariants();

    const rl = ['b', 'd', 'c']; // right subtree left-heavy -> right-left
    t = new IntervalIndex<number>();
    for (const id of rl) t = t.add({ id, start: 0, end: 1, value: 0 });
    t.checkInvariants();

    // Deletions also rotate; hammer a larger tree down to empty.
    t = new IntervalIndex<number>();
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    for (const id of letters) {
      t = t.add({ id, start: -id.charCodeAt(0), end: id.charCodeAt(0), value: 0 });
    }
    for (const id of letters) {
      t = t.remove(id);
      t.checkInvariants();
    }
    expect(t.size()).toBe(0);
  });
});

describe('maxEnd pruning', () => {
  it('public node count reports tree size', () => {
    let idx = new IntervalIndex<number>();
    for (let i = 0; i < 25; i++) idx = idx.add({ id: `k${i}`, start: i, end: i + 1, value: i });
    expect(idx.nodeCount()).toBe(25);
    expect(idx.size()).toBe(25);
  });

  it('a sparse query beyond every end visits one node instead of the whole tree', () => {
    let idx = new IntervalIndex<number>();
    for (let i = 0; i < 100; i++) {
      idx = idx.add({ id: `id-${String(i).padStart(3, '0')}`, start: i, end: i + 1, value: i });
    }
    idx.checkInvariants();
    expect(idx.nodeCount()).toBe(100);

    const stats: QueryStats = { nodesVisited: 0 };
    const hits = idx.overlap(10_000, 10_001, stats);
    expect(hits).toHaveLength(0);
    // Root maxEnd <= query start, so the entire tree is pruned at the root.
    expect(stats.nodesVisited).toBe(1);
  });

  it('prunes most subtrees for a point-ish sparse query', () => {
    let idx = new IntervalIndex<number>();
    // Sparse layout: single-point intervals separated by wide empty gaps.
    for (let i = 0; i < 100; i++) {
      const base = i * 10_000;
      idx = idx.add({
        id: `sparse-${String(i).padStart(3, '0')}`,
        start: base,
        end: base + 1,
        value: i,
      });
    }
    expect(idx.nodeCount()).toBe(100);

    // Query for the last interval: every left sibling subtree along the
    // right spine has maxEnd far below the start and is pruned wholesale.
    const stats: QueryStats = { nodesVisited: 0 };
    const hits = idx.overlap(990_000, 990_001, stats);
    expect(ids(hits)).toEqual(['sparse-099']);
    expect(stats.nodesVisited).toBeLessThan(20); // not a full 100-node scan

    // A query after everything is answered at the root alone.
    const tail: QueryStats = { nodesVisited: 0 };
    expect(idx.overlap(10_000_000, 10_000_001, tail)).toHaveLength(0);
    expect(tail.nodesVisited).toBe(1);
  });

  it('stats are optional', () => {
    const idx = new IntervalIndex<number>().add({ id: 'a', start: 0, end: 1, value: 0 });
    expect(idx.overlap(0, 1)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Random differential tests against a naive Map-based reference model
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function naiveOverlap<V>(items: Map<string, Interval<V>>, start: number, end: number) {
  return [...items.values()]
    .filter((x) => x.start !== x.end && start !== end && x.start < end && x.end > start)
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : 1))
    .map((i) => i.id);
}

function naiveContains<V>(items: Map<string, Interval<V>>, start: number, end: number) {
  return [...items.values()]
    .filter((x) =>
      start === end
        ? x.start === start && x.end === end
        : x.start !== x.end && x.start >= start && x.end <= end,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : 1))
    .map((i) => i.id);
}

describe('random differential tests', () => {
  const seeds = [1, 2, 7, 42, 99, 1234, 7777, 20240923];

  it('matches the naive model across adds, removes, overlaps and contains', () => {
    for (const seed of seeds) {
      const rnd = mulberry32(seed);
      const ref = new Map<string, Interval<number>>();
      let idx = new IntervalIndex<number>();
      const snapshots: Array<{ idx: IntervalIndex<number>; ref: Map<string, Interval<number>> }> = [];

      for (let step = 0; step < 300; step++) {
        const roll = rnd();
        if (roll < 0.6) {
          const id = `k${Math.floor(rnd() * 40)};`; // reuse ids -> updates/deletes
          const start = Math.floor(rnd() * 21) - 10;
          // 15% empty intervals
          const end = rnd() < 0.15 ? start : start + Math.floor(rnd() * 6);
          const item: Interval<number> = { id, start, end, value: step };
          idx = idx.add(item);
          ref.set(id, { ...item });
        } else if (roll < 0.8) {
          const id = `k${Math.floor(rnd() * 40)};`;
          idx = idx.remove(id);
          ref.delete(id);
        } else {
          const start = Math.floor(rnd() * 23) - 11;
          const end = rnd() < 0.2 ? start : start + Math.floor(rnd() * 7);
          if (end < start) continue;
          expect(ids(idx.overlap(start, end)), `seed ${seed} overlap [${start},${end})`)
            .toEqual(naiveOverlap(ref, start, end));
          expect(ids(idx.contains(start, end)), `seed ${seed} contains [${start},${end})`)
            .toEqual(naiveContains(ref, start, end));
        }
        idx.checkInvariants();
        expect(idx.size(), `seed ${seed} size at step ${step}`).toBe(ref.size);
        if (step % 25 === 0) snapshots.push({ idx, ref: new Map(ref) });
      }

      // Persistence: every retained snapshot still agrees with its reference.
      for (const snap of snapshots) {
        for (let q = -12; q <= 14; q++) {
          expect(ids(snap.idx.overlap(q, q + 3))).toEqual(naiveOverlap(snap.ref, q, q + 3));
          expect(ids(snap.idx.contains(q, q + 3))).toEqual(naiveContains(snap.ref, q, q + 3));
        }
      }
    }
  });
});
