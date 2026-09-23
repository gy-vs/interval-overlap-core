import { describe, expect, it } from 'vitest';
import { IntervalIndex, type Interval, type QueryStats } from '../src/index.js';

/** 确定性伪随机数（mulberry32），保证差分测试可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byStartEndId = <V>(a: Interval<V>, b: Interval<V>): number =>
  a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 暴力模型：与实现采用完全相同的空区间策略与排序规则。 */
function bruteOverlap(model: Map<string, Interval<number>>, qs: number, qe: number): Interval<number>[] {
  if (qs === qe) return [];
  return [...model.values()]
    .filter((i) => i.start < qe && i.end > qs && i.start < i.end)
    .sort(byStartEndId);
}

function bruteContained(model: Map<string, Interval<number>>, qs: number, qe: number): Interval<number>[] {
  return [...model.values()].filter((i) => i.start >= qs && i.end <= qe).sort(byStartEndId);
}

describe('旋转与增强值同步', () => {
  const cases: Array<{ name: string; order: string[] }> = [
    { name: 'RR（顺序 a,b,c 触发左旋）', order: ['a', 'b', 'c'] },
    { name: 'LL（逆序 c,b,a 触发右旋）', order: ['c', 'b', 'a'] },
    { name: 'LR（a,c,b 触发左-右双旋）', order: ['a', 'c', 'b'] },
    { name: 'RL（c,a,b 触发右-左双旋）', order: ['c', 'a', 'b'] },
  ];
  const coords: Record<string, [number, number]> = { a: [0, 10], b: [-5, 3], c: [7, 20] };

  for (const { name, order } of cases) {
    it(name, () => {
      let idx = IntervalIndex.empty<number>();
      order.forEach((id, i) => {
        const [start, end] = coords[id];
        idx = idx.add({ id, start, end, value: i });
      });
      idx.checkInvariants(); // 旋转后 BST / 平衡 / 增强值全部一致
      expect(idx.height()).toBe(2);
      expect(idx.size()).toBe(3);
      expect(idx.maxEnd()).toBe(20);
      expect(idx.minStart()).toBe(-5);
      expect(idx.overlap(-100, 100).map((i) => i.id)).toEqual(['b', 'a', 'c']);
    });
  }

  it('顺序插入 1000 项：每步旋转后不变量与增强值都正确，高度对数有界', () => {
    let idx = IntervalIndex.empty<number>();
    let maxEnd = -Infinity;
    let minStart = Infinity;
    for (let i = 0; i < 1000; i++) {
      const start = ((i * 37) % 500) - 250; // 乱序坐标，含负值
      const end = start + (i % 20);
      idx = idx.add({ id: `k${String(i).padStart(4, '0')}`, start, end, value: i });
      maxEnd = Math.max(maxEnd, end);
      minStart = Math.min(minStart, start);
      idx.checkInvariants();
      expect(idx.maxEnd()).toBe(maxEnd);
      expect(idx.minStart()).toBe(minStart);
    }
    expect(idx.height()).toBeLessThanOrEqual(Math.ceil(1.45 * Math.log2(1000 + 2)));
  });

  it('随机顺序逐个删除（含删除根）后保持平衡与正确', () => {
    const rand = mulberry32(7);
    let idx = IntervalIndex.empty<number>();
    const N = 255;
    for (let i = 0; i < N; i++) {
      idx = idx.add({ id: `k${String(i).padStart(3, '0')}`, start: i, end: i + 1, value: i });
    }
    const order = Array.from({ length: N }, (_, i) => `k${String(i).padStart(3, '0')}`);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let remaining = N;
    for (const id of order) {
      idx = idx.remove(id);
      remaining -= 1;
      idx.checkInvariants();
      expect(idx.size()).toBe(remaining);
      expect(idx.has(id)).toBe(false);
    }
    expect(idx.nodeCount()).toBe(0);
    expect(idx.overlap(-10, 1000)).toEqual([]);
    expect(idx.maxEnd()).toBeUndefined();
  });
});

describe('随机差分（对照暴力模型）', () => {
  it('随机增删 + 随机查询结果一致，且历史快照不受后续修改影响', () => {
    const rand = mulberry32(0xc0ffee);
    const pick = (n: number) => Math.floor(rand() * n);
    let idx = IntervalIndex.empty<number>();
    const model = new Map<string, Interval<number>>();
    const snapshots: Array<{ idx: IntervalIndex<number>; model: Map<string, Interval<number>> }> = [];

    const randRange = (): [number, number] => {
      let a = pick(2201) - 1100; // 覆盖负坐标
      let b = pick(2201) - 1100;
      if (b < a) [a, b] = [b, a];
      return [a, b];
    };

    for (let step = 0; step < 2000; step++) {
      const op = rand();
      if (op < 0.55 || model.size === 0) {
        const id = `k${pick(400)}`;
        const [start, end0] = randRange();
        const end = rand() < 0.1 ? start : end0; // 10% 空区间
        const item: Interval<number> = { id, start, end, value: step };
        idx = idx.add(item);
        model.set(id, item);
      } else {
        const id = `k${pick(400)}`;
        idx = idx.remove(id);
        model.delete(id);
      }
      idx.checkInvariants();
      expect(idx.size()).toBe(model.size);

      if (step % 200 === 0) snapshots.push({ idx, model: new Map(model) });

      if (step % 5 === 0) {
        const [qs, qe] = randRange();
        expect(idx.overlap(qs, qe)).toEqual(bruteOverlap(model, qs, qe));
        expect(idx.contained(qs, qe)).toEqual(bruteContained(model, qs, qe));
        const probe = `k${pick(400)}`;
        expect(idx.has(probe)).toBe(model.has(probe));
        expect(idx.get(probe)).toEqual(model.get(probe));
      }
    }

    // 旧版本快照：之后的 2000 步修改不影响当时的查询结果
    for (const snap of snapshots) {
      snap.idx.checkInvariants();
      expect(snap.idx.size()).toBe(snap.model.size);
      for (let q = 0; q < 20; q++) {
        const [qs, qe] = randRange();
        expect(snap.idx.overlap(qs, qe)).toEqual(bruteOverlap(snap.model, qs, qe));
        expect(snap.idx.contained(qs, qe)).toEqual(bruteContained(snap.model, qs, qe));
      }
    }
  });
});

describe('稀疏查询的剪枝效果', () => {
  it('访问节点数远小于全树节点数', () => {
    let idx = IntervalIndex.empty<number>();
    const N = 4096;
    for (let i = 0; i < N; i++) {
      // id 与坐标同向分配（如自增 id），子树包围盒紧致，剪枝最有效
      idx = idx.add({ id: `id${String(i).padStart(6, '0')}`, start: i * 16, end: i * 16 + 2, value: i });
    }
    idx.checkInvariants();
    expect(idx.nodeCount()).toBe(N);

    const stats: QueryStats = { visited: 0 };
    const hits = idx.overlap(100 * 16 + 1, 100 * 16 + 3, stats);
    expect(hits.map((h) => h.id)).toEqual([`id${String(100).padStart(6, '0')}`]);
    expect(stats.visited).toBeLessThan(100); // 远小于 4096，未全树扫描
    expect(stats.visited).toBeLessThan(idx.nodeCount() / 10);

    // 命中空区域的查询同样被剪枝
    const s2: QueryStats = { visited: 0 };
    expect(idx.overlap(100 * 16 + 4, 100 * 16 + 14, s2)).toEqual([]);
    expect(s2.visited).toBeLessThan(100);
  });
});
