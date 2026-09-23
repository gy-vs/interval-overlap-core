# Persistent interval index

TypeScript library storing half-open intervals `[start, end)` in a persistent
(copy-on-write) AVL tree keyed by a stable string `id`. Every node augments its
subtree with `maxEnd`, recomputed on every rotation and path copy, so overlap
queries prune subtrees that cannot intersect the query.

- Intervals are half-open: `[1, 3)` and `[3, 5)` are adjacent and do not overlap.
- `start === end` is a valid **empty interval**: it never overlaps anything and
  is contained only by an empty query `[x, x)` at the same coordinate.
- `end < start` throws.
- Results of `overlap` / `contains` are sorted stably by `start`, then `end`,
  then `id`.
- `add` / `remove` return a new version; previous versions remain queryable and
  share untouched subtrees. Adding an existing id replaces that interval.

```ts
import { IntervalIndex } from './src/index.js';

const v1 = new IntervalIndex<number>()
  .add({ id: 'a', start: 0, end: 10, value: 1 })
  .add({ id: 'b', start: 5, end: 15, value: 2 });

v1.overlap(4, 6).map((i) => i.id);   // ['a', 'b']  — sorted by start,end,id
v1.contains(0, 10).map((i) => i.id); // ['a']       — fully contained only

const stats = { nodesVisited: 0 };
v1.overlap(1_000_000, 1_000_001, stats);
stats.nodesVisited;                  // 1 — root subtree pruned via maxEnd
v1.nodeCount();                      // 2

const v2 = v1.remove('a');           // v1 is unchanged (persistent)
```

Run `npm install`, then `npm test` and `npm run build`.
