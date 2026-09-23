/**
 * 持久化（不可变）区间索引：以稳定 id 为键的 AVL 平衡树，区间采用半开 [start, end)。
 *
 * 设计要点：
 * - 每个节点维护子树增强值 maxEnd / minStart；插入、删除与旋转全部以
 *   copy-on-write 方式重建路径上的节点并同步重算增强值，旧版本索引不受新修改影响；
 * - 重叠查询按 (start, end, id) 稳定排序返回，并利用 maxEnd / minStart 剪枝，
 *   稀疏查询不会全树扫描（可通过 QueryStats.visited 观察访问节点数）；
 * - id 按码元序比较（不依赖 locale），保证跨环境结果一致。
 *
 * 空区间策略（明确）：
 * - 允许存储 start === end 的空区间；end < start 或 NaN 端点抛出 RangeError；
 * - 空区间与任何区间都不重叠：overlap 永不返回空区间，空查询 [p, p) 返回空数组；
 * - 空区间 [p, p) 被认为完全包含于查询 [qs, qe) 当且仅当 qs <= p <= qe
 *   （contained 对所有项统一适用规则 qs <= start 且 end <= qe）。
 */

/** 存储的区间项。id 为稳定标识；[start, end) 半开；允许 start === end（空区间）。 */
export interface Interval<V> {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly value: V;
}

/** 查询统计：visited 为查询过程中访问（读取）的节点数，用于验证剪枝效果。 */
export interface QueryStats {
  visited: number;
}

interface Node<V> {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly value: V;
  readonly left: Node<V> | null;
  readonly right: Node<V> | null;
  readonly height: number;
  /** 子树（含自身）的最大 end。 */
  readonly maxEnd: number;
  /** 子树（含自身）的最小 start。 */
  readonly minStart: number;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIntervals<V>(a: Interval<V>, b: Interval<V>): number {
  return a.start - b.start || a.end - b.end || compareIds(a.id, b.id);
}

function heightOf<V>(n: Node<V> | null): number {
  return n === null ? 0 : n.height;
}

/** 由子节点重算增强值并创建新节点（copy-on-write 的基本单元，旧节点永不被修改）。 */
function makeNode<V>(
  id: string,
  start: number,
  end: number,
  value: V,
  left: Node<V> | null,
  right: Node<V> | null,
): Node<V> {
  let height = 1;
  let maxEnd = end;
  let minStart = start;
  if (left !== null) {
    if (left.height + 1 > height) height = left.height + 1;
    if (left.maxEnd > maxEnd) maxEnd = left.maxEnd;
    if (left.minStart < minStart) minStart = left.minStart;
  }
  if (right !== null) {
    if (right.height + 1 > height) height = right.height + 1;
    if (right.maxEnd > maxEnd) maxEnd = right.maxEnd;
    if (right.minStart < minStart) minStart = right.minStart;
  }
  return { id, start, end, value, left, right, height, maxEnd, minStart };
}

/** 右旋：提升左孩子。旋转通过创建新节点完成，增强值随新节点同步重算。 */
function rotateRight<V>(y: Node<V>): Node<V> {
  const x = y.left as Node<V>;
  const newY = makeNode(y.id, y.start, y.end, y.value, x.right, y.right);
  return makeNode(x.id, x.start, x.end, x.value, x.left, newY);
}

/** 左旋：提升右孩子。 */
function rotateLeft<V>(x: Node<V>): Node<V> {
  const y = x.right as Node<V>;
  const newX = makeNode(x.id, x.start, x.end, x.value, x.left, y.left);
  return makeNode(y.id, y.start, y.end, y.value, newX, y.right);
}

function rebalance<V>(n: Node<V>): Node<V> {
  const bf = heightOf(n.left) - heightOf(n.right);
  if (bf > 1) {
    const left = n.left as Node<V>;
    if (heightOf(left.left) < heightOf(left.right)) {
      return rotateRight(makeNode(n.id, n.start, n.end, n.value, rotateLeft(left), n.right));
    }
    return rotateRight(n);
  }
  if (bf < -1) {
    const right = n.right as Node<V>;
    if (heightOf(right.right) < heightOf(right.left)) {
      return rotateLeft(makeNode(n.id, n.start, n.end, n.value, n.left, rotateRight(right)));
    }
    return rotateLeft(n);
  }
  return n;
}

interface InsertResult<V> {
  node: Node<V>;
  inserted: boolean;
}

function insertNode<V>(n: Node<V> | null, item: Interval<V>): InsertResult<V> {
  if (n === null) {
    return { node: makeNode(item.id, item.start, item.end, item.value, null, null), inserted: true };
  }
  const cmp = compareIds(item.id, n.id);
  if (cmp < 0) {
    const r = insertNode(n.left, item);
    return { node: rebalance(makeNode(n.id, n.start, n.end, n.value, r.node, n.right)), inserted: r.inserted };
  }
  if (cmp > 0) {
    const r = insertNode(n.right, item);
    return { node: rebalance(makeNode(n.id, n.start, n.end, n.value, n.left, r.node)), inserted: r.inserted };
  }
  // 相同 id：替换整个条目（仍走 copy-on-write，旧版本不受影响）
  return { node: makeNode(item.id, item.start, item.end, item.value, n.left, n.right), inserted: false };
}

interface RemoveResult<V> {
  node: Node<V> | null;
  removed: boolean;
}

function minNode<V>(n: Node<V>): Node<V> {
  let cur = n;
  while (cur.left !== null) cur = cur.left;
  return cur;
}

function removeMinNode<V>(n: Node<V>): Node<V> | null {
  if (n.left === null) return n.right;
  return rebalance(makeNode(n.id, n.start, n.end, n.value, removeMinNode(n.left), n.right));
}

function removeNode<V>(n: Node<V> | null, id: string): RemoveResult<V> {
  if (n === null) return { node: null, removed: false };
  const cmp = compareIds(id, n.id);
  if (cmp < 0) {
    const r = removeNode(n.left, id);
    if (!r.removed) return { node: n, removed: false };
    return { node: rebalance(makeNode(n.id, n.start, n.end, n.value, r.node, n.right)), removed: true };
  }
  if (cmp > 0) {
    const r = removeNode(n.right, id);
    if (!r.removed) return { node: n, removed: false };
    return { node: rebalance(makeNode(n.id, n.start, n.end, n.value, n.left, r.node)), removed: true };
  }
  if (n.left === null) return { node: n.right, removed: true };
  if (n.right === null) return { node: n.left, removed: true };
  // 双子：用右子树最小节点（后继）的数据替换，并从右子树中删除后继
  const succ = minNode(n.right);
  const newRight = removeMinNode(n.right);
  return {
    node: rebalance(makeNode(succ.id, succ.start, succ.end, succ.value, n.left, newRight)),
    removed: true,
  };
}

function validateItem<V>(item: Interval<V>): void {
  if (typeof item.id !== 'string') throw new TypeError('interval id must be a string');
  if (!(item.end >= item.start)) {
    throw new RangeError(`invalid interval [${item.start}, ${item.end}): end must be >= start`);
  }
}

function validateRange(start: number, end: number): void {
  if (!(end >= start)) {
    throw new RangeError(`invalid query range [${start}, ${end}): end must be >= start`);
  }
}

export class IntervalIndex<V> {
  private root: Node<V> | null;
  private count: number;

  /** 创建索引；可选地由条目集合构建（相同 id 后出现的覆盖先出现的）。 */
  constructor(items: Iterable<Interval<V>> = []) {
    let root: Node<V> | null = null;
    let count = 0;
    for (const item of items) {
      validateItem(item);
      const r: InsertResult<V> = insertNode(root, item);
      root = r.node;
      if (r.inserted) count += 1;
    }
    this.root = root;
    this.count = count;
  }

  /** 空索引。 */
  static empty<V>(): IntervalIndex<V> {
    return new IntervalIndex<V>();
  }

  /** 由条目集合构建索引（相同 id 后出现的覆盖先出现的）。 */
  static from<V>(items: Iterable<Interval<V>>): IntervalIndex<V> {
    return new IntervalIndex<V>(items);
  }

  private static wrap<V>(root: Node<V> | null, count: number): IntervalIndex<V> {
    const idx = new IntervalIndex<V>();
    idx.root = root;
    idx.count = count;
    return idx;
  }

  /** 条目数（每个 id 至多一条）。 */
  size(): number {
    return this.count;
  }

  /** 树中节点总数（与 size 相同，每个条目对应一个节点）。 */
  nodeCount(): number {
    return this.count;
  }

  /** 树高（空树为 0）。 */
  height(): number {
    return heightOf(this.root);
  }

  /** 整棵树的 maxEnd 增强值（空索引为 undefined）。 */
  maxEnd(): number | undefined {
    return this.root === null ? undefined : this.root.maxEnd;
  }

  /** 整棵树的 minStart 增强值（空索引为 undefined）。 */
  minStart(): number | undefined {
    return this.root === null ? undefined : this.root.minStart;
  }

  has(id: string): boolean {
    return this.findNode(id) !== null;
  }

  get(id: string): Interval<V> | undefined {
    const n = this.findNode(id);
    return n === null ? undefined : { id: n.id, start: n.start, end: n.end, value: n.value };
  }

  private findNode(id: string): Node<V> | null {
    let n = this.root;
    while (n !== null) {
      const cmp = compareIds(id, n.id);
      if (cmp < 0) n = n.left;
      else if (cmp > 0) n = n.right;
      else return n;
    }
    return null;
  }

  /**
   * 插入或替换（相同 id 覆盖）一个区间，返回新索引；旧索引不受影响。
   * 允许空区间（start === end）；end < start 或 NaN 抛出 RangeError。
   */
  add(item: Interval<V>): IntervalIndex<V> {
    validateItem(item);
    const r = insertNode(this.root, item);
    return IntervalIndex.wrap(r.node, this.count + (r.inserted ? 1 : 0));
  }

  /** 删除指定 id 的区间，返回新索引；id 不存在时返回同一实例。 */
  remove(id: string): IntervalIndex<V> {
    const r = removeNode(this.root, id);
    if (!r.removed) return this;
    return IntervalIndex.wrap(r.node, this.count - 1);
  }

  /**
   * 返回与 [start, end) 重叠的所有项，按 (start, end, id) 稳定排序。
   * 空区间与任何区间都不重叠；空查询（start === end）返回空数组。
   * 利用子树 maxEnd / minStart 剪枝；stats.visited 记录访问的节点数。
   */
  overlap(start: number, end: number, stats?: QueryStats): Interval<V>[] {
    validateRange(start, end);
    const out: Interval<V>[] = [];
    if (start === end) return out; // 空查询不与任何区间重叠
    const visit = (n: Node<V> | null): void => {
      if (n === null) return;
      if (stats) stats.visited += 1;
      if (n.minStart >= end) return; // 子树所有区间都在查询右侧（含相邻），剪枝
      if (n.maxEnd <= start) return; // 子树所有区间都在查询左侧（含相邻），剪枝
      visit(n.left);
      if (n.start < end && n.end > start && n.start < n.end) {
        out.push({ id: n.id, start: n.start, end: n.end, value: n.value });
      }
      visit(n.right);
    };
    visit(this.root);
    out.sort(compareIntervals);
    return out;
  }

  /**
   * 返回完全包含于 [start, end) 的所有项（qs <= 项.start 且 项.end <= qe），
   * 按 (start, end, id) 稳定排序。空区间 [p, p) 当 qs <= p <= qe 时视为被包含。
   * 利用子树 maxEnd / minStart 做包围盒剪枝；stats.visited 记录访问的节点数。
   */
  contained(start: number, end: number, stats?: QueryStats): Interval<V>[] {
    validateRange(start, end);
    const out: Interval<V>[] = [];
    const visit = (n: Node<V> | null): void => {
      if (n === null) return;
      if (stats) stats.visited += 1;
      if (n.minStart > end) return; // 子树所有区间起点都在查询右侧，不可能被包含
      if (n.maxEnd < start) return; // 子树所有区间终点都在查询左侧，不可能被包含
      visit(n.left);
      if (n.start >= start && n.end <= end) {
        out.push({ id: n.id, start: n.start, end: n.end, value: n.value });
      }
      visit(n.right);
    };
    visit(this.root);
    out.sort(compareIntervals);
    return out;
  }

  /**
   * 校验树结构不变量（BST 顺序、AVL 平衡、height / maxEnd / minStart 增强值、
   * 节点数），发现不一致即抛出 Error。主要用于测试与调试。
   */
  checkInvariants(): void {
    let nodes = 0;
    const check = (
      n: Node<V> | null,
      lo: string | null,
      hi: string | null,
    ): { height: number; maxEnd: number; minStart: number } => {
      if (n === null) return { height: 0, maxEnd: -Infinity, minStart: Infinity };
      nodes += 1;
      if (lo !== null && compareIds(n.id, lo) <= 0) {
        throw new Error(`BST invariant violated: id ${n.id} <= lower bound ${lo}`);
      }
      if (hi !== null && compareIds(n.id, hi) >= 0) {
        throw new Error(`BST invariant violated: id ${n.id} >= upper bound ${hi}`);
      }
      if (!(n.end >= n.start)) {
        throw new Error(`invalid interval stored at ${n.id}: [${n.start}, ${n.end})`);
      }
      const l = check(n.left, lo, n.id);
      const r = check(n.right, n.id, hi);
      const height = 1 + Math.max(l.height, r.height);
      if (n.height !== height) {
        throw new Error(`height mismatch at ${n.id}: stored ${n.height}, actual ${height}`);
      }
      if (Math.abs(l.height - r.height) > 1) {
        throw new Error(`AVL balance violated at ${n.id}: |${l.height} - ${r.height}| > 1`);
      }
      const maxEnd = Math.max(n.end, l.maxEnd, r.maxEnd);
      if (n.maxEnd !== maxEnd) {
        throw new Error(`maxEnd mismatch at ${n.id}: stored ${n.maxEnd}, actual ${maxEnd}`);
      }
      const minStart = Math.min(n.start, l.minStart, r.minStart);
      if (n.minStart !== minStart) {
        throw new Error(`minStart mismatch at ${n.id}: stored ${n.minStart}, actual ${minStart}`);
      }
      return { height, maxEnd, minStart };
    };
    check(this.root, null, null);
    if (nodes !== this.count) {
      throw new Error(`size mismatch: count ${this.count}, actual nodes ${nodes}`);
    }
  }
}
