/**
 * Persistent interval index.
 *
 * Intervals are half-open: `[start, end)`, so `start === end` denotes a valid
 * empty interval. Empty intervals contain no points: they never overlap
 * anything (including other empty intervals), and they are contained only by
 * another empty interval at the same coordinate.
 *
 * The underlying structure is a persistent (copy-on-write) AVL tree keyed by
 * the stable interval id. Each node augments its subtree with `maxEnd`, the
 * greatest `end` of every interval below it. All rotations and path copies
 * recompute the augmentation, so overlap queries can prune subtrees whose
 * `maxEnd` is not greater than the query start.
 *
 * `add` / `remove` never mutate the receiver; every method returns a fresh
 * version and old versions keep answering queries as before.
 */

export interface Interval<V> {
  id: string;
  start: number;
  end: number;
  value: V;
}

/** Number of nodes inspected by a query; 1 when a subtree is pruned. */
export interface QueryStats {
  nodesVisited: number;
}

interface Node<V> {
  item: Interval<V>;
  /** Left subtree: ids lexicographically smaller than this node's id. */
  left: Node<V> | null;
  right: Node<V> | null;
  /** AVL height of a leaf is 1. */
  height: number;
  /** 1 + sizes of both children. */
  count: number;
  /** Greatest `end` in the subtree (the node included). */
  maxEnd: number;
}

// ---------------------------------------------------------------------------
// Augmentation
// ---------------------------------------------------------------------------

/** Recompute height / count / maxEnd from the children. Pure. */
function pull<V>(node: Node<V>): Node<V> {
  const left = node.left;
  const right = node.right;
  let maxEnd = node.item.end;
  if (left !== null && left.maxEnd > maxEnd) maxEnd = left.maxEnd;
  if (right !== null && right.maxEnd > maxEnd) maxEnd = right.maxEnd;
  return {
    ...node,
    height: 1 + Math.max(left ? left.height : 0, right ? right.height : 0),
    count: 1 + (left ? left.count : 0) + (right ? right.count : 0),
    maxEnd,
  };
}

function cloneNode<V>(
  node: Node<V>,
  left: Node<V> | null,
  right: Node<V> | null,
): Node<V> {
  return pull({ ...node, left, right });
}

// ---------------------------------------------------------------------------
// Rotations — every rotation allocates fresh nodes, keeping old versions
// intact, and pulls the augmentation on every node it produces.
// ---------------------------------------------------------------------------

function rotateRight<V>(y: Node<V>): Node<V> {
  const x = y.left as Node<V>;
  const newY = cloneNode(y, x.right, y.right);
  return cloneNode(x, x.left, newY);
}

function rotateLeft<V>(x: Node<V>): Node<V> {
  const y = x.right as Node<V>;
  const newX = cloneNode(x, x.left, y.left);
  return cloneNode(y, newX, y.right);
}

function balance<V>(node: Node<V>): Node<V> {
  const bf = height(node.right) - height(node.left);
  if (bf > 1) {
    const right = node.right as Node<V>;
    if (height(right.left) > height(right.right)) {
      // right-left: rotate the heavy child first
      return rotateLeft(cloneNode(node, node.left, rotateRight(right)));
    }
    return rotateLeft(node);
  }
  if (bf < -1) {
    const left = node.left as Node<V>;
    if (height(left.right) > height(left.left)) {
      // left-right
      return rotateRight(cloneNode(node, rotateLeft(left), node.right));
    }
    return rotateRight(node);
  }
  return node;
}

function height<V>(node: Node<V> | null): number {
  return node ? node.height : 0;
}

// ---------------------------------------------------------------------------
// Interval predicates (half-open semantics)
// ---------------------------------------------------------------------------

function isEmpty(item: Interval<unknown>): boolean {
  return item.start === item.end;
}

/**
 * Two non-empty half-open intervals overlap iff `a.start < b.end &&
 * a.end > b.start`. Empty intervals overlap nobody, regardless of endpoint.
 */
function overlaps<V>(a: Interval<V>, start: number, end: number): boolean {
  if (isEmpty(a) || start === end) return false;
  return a.start < end && a.end > start;
}

/**
 * A non-empty query contains a non-empty item when its bounds cover it.
 * An empty interval is contained only by an empty query at the same
 * coordinate. A non-empty query never contains an empty item.
 */
function containedBy<V>(a: Interval<V>, start: number, end: number): boolean {
  if (start === end) return isEmpty(a) && a.start === start;
  if (isEmpty(a)) return false;
  return a.start >= start && a.end <= end;
}

function compareIntervals<V>(a: Interval<V>, b: Interval<V>): number {
  return a.start - b.start || a.end - b.end || compareId(a.id, b.id);
}

// Deterministic ordering of stable ids, independent of locale.
function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Persistent insertion / removal, keyed by stable id
// ---------------------------------------------------------------------------

function insert<V>(node: Node<V> | null, item: Interval<V>): Node<V> {
  if (node === null) {
    return {
      item,
      left: null,
      right: null,
      height: 1,
      count: 1,
      maxEnd: item.end,
    };
  }
  if (item.id === node.item.id) {
    // Stable id identifies the item: overwrite in place, one fresh node.
    return pull({ ...node, item });
  }
  if (item.id < node.item.id) {
    return balance(cloneNode(node, insert(node.left, item), node.right));
  }
  return balance(cloneNode(node, node.left, insert(node.right, item)));
}

function minNode<V>(node: Node<V>): Node<V> {
  let cur = node;
  while (cur.left !== null) cur = cur.left;
  return cur;
}

function eraseMin<V>(node: Node<V>): Node<V> | null {
  if (node.left === null) return node.right;
  return balance(cloneNode(node, eraseMin(node.left), node.right));
}

function erase<V>(node: Node<V> | null, id: string): Node<V> | null {
  if (node === null) return null;
  if (id < node.item.id) {
    return rebalanceChild(node, erase(node.left, id), true);
  }
  if (id > node.item.id) {
    return rebalanceChild(node, erase(node.right, id), false);
  }
  // Remove this node (including when it is the root).
  if (node.left === null) return node.right;
  if (node.right === null) return node.left;
  const successor = minNode(node.right);
  const right = eraseMin(node.right);
  return balance(cloneNode({ ...node, item: successor.item }, node.left, right));
}

/**
 * Persistently swap one child (already updated or null) and rebalance.
 * Returns null when the replacement is identical, so the tree is shared and
 * a missing id does not allocate anything.
 */
function rebalanceChild<V>(
  node: Node<V>,
  child: Node<V> | null,
  isLeft: boolean,
): Node<V> {
  const current = isLeft ? node.left : node.right;
  if (child === current) return node;
  return balance(
    cloneNode(node, isLeft ? child : node.left, isLeft ? node.right : child),
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function collectOverlap<V>(
  node: Node<V> | null,
  start: number,
  end: number,
  out: Interval<V>[],
  stats: QueryStats,
): void {
  if (node === null) return;
  stats.nodesVisited++;
  // No interval in this subtree ends after `start`: nothing can overlap.
  if (node.maxEnd <= start) return;
  collectOverlap(node.left, start, end, out, stats);
  if (overlaps(node.item, start, end)) out.push(node.item);
  collectOverlap(node.right, start, end, out, stats);
}

function collectContained<V>(
  node: Node<V> | null,
  start: number,
  end: number,
  out: Interval<V>[],
  stats: QueryStats,
): void {
  // `maxEnd` cannot prune containment queries (an early-ending interval may
  // still be fully inside the query), so the whole keyed tree is inspected.
  if (node === null) return;
  stats.nodesVisited++;
  collectContained(node.left, start, end, out, stats);
  if (containedBy(node.item, start, end)) out.push(node.item);
  collectContained(node.right, start, end, out, stats);
}

function validate(start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error(`invalid interval [${start}, ${end})`);
  }
}

function buildRoot<V>(items: ReadonlyArray<Interval<V>>): Node<V> | null {
  let root: Node<V> | null = null;
  for (const item of items) root = insert(root, item);
  return root;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class IntervalIndex<V> {
  /**
   * Backwards-compatible construction: `new IntervalIndex()` creates an empty
   * index and `new IntervalIndex(items)` builds from a list of intervals.
   */
  constructor(rootOrItems: Node<V> | null | ReadonlyArray<Interval<V>> = null) {
    this.root = Array.isArray(rootOrItems)
      ? buildRoot(rootOrItems)
      : (rootOrItems as Node<V> | null);
  }

  private readonly root: Node<V> | null;

  static fromItems<V>(items: ReadonlyArray<Interval<V>>): IntervalIndex<V> {
    return new IntervalIndex(buildRoot(items));
  }

  /** Returns a new index containing `item`; an equal id replaces the item. */
  add(item: Interval<V>): IntervalIndex<V> {
    validate(item.start, item.end);
    return new IntervalIndex(insert(this.root, item));
  }

  /** Returns a new index without the id; a missing id is a no-op. */
  remove(id: string): IntervalIndex<V> {
    return new IntervalIndex(erase(this.root, id));
  }

  /**
   * All stored intervals overlapping the half-open query `[start, end)`.
   * Sorted stably by start, then end, then id.
   */
  overlap(
    start: number,
    end: number,
    stats?: QueryStats,
  ): Interval<V>[] {
    validate(start, end);
    const result: Interval<V>[] = [];
    const localStats: QueryStats = stats ?? { nodesVisited: 0 };
    collectOverlap(this.root, start, end, result, localStats);
    if (stats) stats.nodesVisited = localStats.nodesVisited;
    return result.sort(compareIntervals);
  }

  /** All stored intervals fully contained in the half-open query. */
  contains(
    start: number,
    end: number,
    stats?: QueryStats,
  ): Interval<V>[] {
    validate(start, end);
    const result: Interval<V>[] = [];
    const localStats: QueryStats = stats ?? { nodesVisited: 0 };
    collectContained(this.root, start, end, result, localStats);
    if (stats) stats.nodesVisited = localStats.nodesVisited;
    return result.sort(compareIntervals);
  }

  size(): number {
    return this.root ? this.root.count : 0;
  }

  /** Total nodes in the backing tree (equal to the number of intervals). */
  nodeCount(): number {
    return this.size();
  }

  /**
   * Internal consistency check used by tests: verifies BST ordering, AVL
   * balance, and height/count/maxEnd augmentation on every node.
   */
  checkInvariants(): void {
    checkNode(this.root, null, null);
  }
}

function checkNode<V>(
  node: Node<V> | null,
  lo: string | null,
  hi: string | null,
): { height: number; count: number; maxEnd: number } {
  if (node === null) return { height: 0, count: 0, maxEnd: -Infinity };
  if (lo !== null && !(lo < node.item.id)) {
    throw new Error(`BST violation: ${lo} < ${node.item.id}`);
  }
  if (hi !== null && !(node.item.id < hi)) {
    throw new Error(`BST violation: ${node.item.id} < ${hi}`);
  }
  const l = checkNode(node.left, lo, node.item.id);
  const r = checkNode(node.right, node.item.id, hi);
  const height = 1 + Math.max(l.height, r.height);
  const count = 1 + l.count + r.count;
  const maxEnd = Math.max(node.item.end, l.maxEnd, r.maxEnd);
  if (height !== node.height) throw new Error(`height mismatch at ${node.item.id}`);
  if (count !== node.count) throw new Error(`count mismatch at ${node.item.id}`);
  if (maxEnd !== node.maxEnd) throw new Error(`maxEnd mismatch at ${node.item.id}`);
  const balanceFactor = r.height - l.height;
  if (balanceFactor < -1 || balanceFactor > 1) {
    throw new Error(`unbalanced node ${node.item.id}: ${balanceFactor}`);
  }
  return { height, count, maxEnd };
}
