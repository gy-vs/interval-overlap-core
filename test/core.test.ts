import { describe, expect, it } from 'vitest';
import { IntervalIndex, type Interval, type QueryStats } from '../src/index.js';

const ids = (items: Interval<unknown>[]) => items.map((i) => i.id);

describe('构造与基本操作', () => {
  it('构造函数与静态工厂', () => {
    const items = [
      { id: 'a', start: 0, end: 1, value: 'x' },
      { id: 'b', start: 2, end: 3, value: 'y' },
    ];
    expect(new IntervalIndex(items).size()).toBe(2);
    expect(new IntervalIndex().size()).toBe(0);
    expect(IntervalIndex.from(items).size()).toBe(2);
    expect(IntervalIndex.empty().size()).toBe(0);
  });

  it('相同 id 覆盖：size 不变，旧版本仍返回旧值', () => {
    const v1 = IntervalIndex.empty<number>().add({ id: 'a', start: 1, end: 5, value: 1 });
    const v2 = v1.add({ id: 'a', start: 100, end: 200, value: 2 });
    expect(v2.size()).toBe(1);
    expect(v2.get('a')).toEqual({ id: 'a', start: 100, end: 200, value: 2 });
    expect(v1.get('a')).toEqual({ id: 'a', start: 1, end: 5, value: 1 });
    expect(v1.maxEnd()).toBe(5);
    expect(v2.maxEnd()).toBe(200);
  });

  it('remove 不存在的 id 返回同一实例', () => {
    const idx = IntervalIndex.empty<number>().add({ id: 'a', start: 1, end: 2, value: 1 });
    expect(idx.remove('nope')).toBe(idx);
  });

  it('非法输入抛出 RangeError / TypeError', () => {
    const idx = IntervalIndex.empty<number>();
    expect(() => idx.add({ id: 'x', start: 5, end: 3, value: 0 })).toThrow(RangeError);
    expect(() => idx.add({ id: 'x', start: Number.NaN, end: 3, value: 0 })).toThrow(RangeError);
    expect(() => idx.add({ id: 1 as unknown as string, start: 0, end: 1, value: 0 })).toThrow(TypeError);
    expect(() => idx.overlap(5, 3)).toThrow(RangeError);
    expect(() => idx.contained(2, 1)).toThrow(RangeError);
    expect(() => idx.overlap(Number.NaN, 3)).toThrow(RangeError);
  });
});

describe('重叠查询', () => {
  it('相邻不重叠（半开区间）', () => {
    const idx = IntervalIndex.empty<number>()
      .add({ id: 'a', start: 1, end: 3, value: 1 })
      .add({ id: 'b', start: 3, end: 5, value: 2 });
    expect(ids(idx.overlap(3, 5))).toEqual(['b']); // [1,3) 与 [3,5) 仅端点相接
    expect(ids(idx.overlap(1, 3))).toEqual(['a']);
    expect(ids(idx.overlap(0, 10))).toEqual(['a', 'b']);
    expect(idx.overlap(5, 8)).toEqual([]);
  });

  it('相同端点的多项按 (start, end, id) 稳定排序', () => {
    const idx = IntervalIndex.empty<number>()
      .add({ id: 'c', start: 2, end: 4, value: 3 })
      .add({ id: 'a', start: 2, end: 4, value: 1 })
      .add({ id: 'b', start: 2, end: 4, value: 2 })
      .add({ id: 'd', start: 1, end: 4, value: 4 })
      .add({ id: 'e', start: 2, end: 3, value: 5 });
    expect(ids(idx.overlap(0, 10))).toEqual(['d', 'e', 'a', 'b', 'c']);
  });

  it('嵌套区间全部命中', () => {
    const idx = IntervalIndex.empty<number>()
      .add({ id: 'outer', start: 0, end: 100, value: 1 })
      .add({ id: 'mid', start: 10, end: 50, value: 2 })
      .add({ id: 'inner', start: 20, end: 30, value: 3 });
    expect(ids(idx.overlap(25, 26))).toEqual(['outer', 'mid', 'inner']);
    expect(ids(idx.overlap(60, 70))).toEqual(['outer']);
  });

  it('负坐标', () => {
    const idx = IntervalIndex.empty<number>()
      .add({ id: 'neg', start: -100, end: -50, value: 1 })
      .add({ id: 'cross', start: -10, end: 10, value: 2 })
      .add({ id: 'pos', start: 50, end: 100, value: 3 });
    expect(ids(idx.overlap(-75, -5))).toEqual(['neg', 'cross']);
    expect(idx.overlap(-1000, -900)).toEqual([]);
    expect(idx.minStart()).toBe(-100);
    expect(idx.maxEnd()).toBe(100);
  });

  it('空区间策略：不参与重叠，空查询返回空', () => {
    const idx = IntervalIndex.empty<number>()
      .add({ id: 'empty', start: 5, end: 5, value: 0 })
      .add({ id: 'normal', start: 1, end: 10, value: 1 });
    expect(ids(idx.overlap(0, 20))).toEqual(['normal']); // 空区间 [5,5) 不算重叠
    expect(idx.overlap(5, 5)).toEqual([]); // 空查询无重叠
    expect(idx.overlap(4, 6).map((i) => i.id)).toEqual(['normal']);
  });
});

describe('完全包含查询', () => {
  const idx = IntervalIndex.empty<number>()
    .add({ id: 'outer', start: 0, end: 100, value: 1 })
    .add({ id: 'mid', start: 10, end: 50, value: 2 })
    .add({ id: 'inner', start: 20, end: 30, value: 3 });

  it('边界相等算包含（qs <= start 且 end <= qe）', () => {
    expect(ids(idx.contained(0, 100))).toEqual(['outer', 'mid', 'inner']);
    expect(ids(idx.contained(10, 50))).toEqual(['mid', 'inner']);
    expect(ids(idx.contained(15, 45))).toEqual(['inner']);
    expect(idx.contained(21, 29)).toEqual([]);
  });

  it('空区间按统一规则判定：点 p 落在闭查询区间内即被包含', () => {
    const withEmpty = idx.add({ id: 'dot', start: 5, end: 5, value: 4 });
    expect(ids(withEmpty.contained(0, 20))).toEqual(['dot']); // mid [10,50) 超出查询右端
    expect(withEmpty.contained(6, 7)).toEqual([]); // 点 5 不在 [6,7] 内
    expect(ids(withEmpty.contained(5, 5))).toEqual(['dot']); // [5,5) ⊆ [5,5)
  });
});

describe('删除', () => {
  it('删除根节点（插入 a,b,c 触发左旋后根为 b）', () => {
    const v1 = IntervalIndex.empty<number>()
      .add({ id: 'a', start: 0, end: 2, value: 1 })
      .add({ id: 'b', start: 4, end: 6, value: 2 })
      .add({ id: 'c', start: 8, end: 10, value: 3 });
    const v2 = v1.remove('b');
    v2.checkInvariants();
    expect(v2.size()).toBe(2);
    expect(v2.has('b')).toBe(false);
    expect(ids(v2.overlap(0, 100))).toEqual(['a', 'c']);
    expect(v2.maxEnd()).toBe(10);
    // 旧版本不受影响
    expect(v1.has('b')).toBe(true);
    expect(v1.size()).toBe(3);
  });

  it('删除叶子与双子节点后查询仍正确', () => {
    let idx = IntervalIndex.empty<number>();
    for (let i = 0; i < 7; i++) {
      idx = idx.add({ id: `k${i}`, start: i * 10, end: i * 10 + 5, value: i });
    }
    idx = idx.remove('k0').remove('k3').remove('k6'); // 叶子 / 中间 / 另一端
    idx.checkInvariants();
    expect(idx.size()).toBe(4);
    expect(ids(idx.overlap(0, 1000))).toEqual(['k1', 'k2', 'k4', 'k5']);
  });
});

describe('持久性', () => {
  it('旧版本查询不受新修改影响', () => {
    const v0 = IntervalIndex.empty<number>();
    const v1 = v0.add({ id: 'a', start: 1, end: 5, value: 1 });
    const v2 = v1.add({ id: 'b', start: 2, end: 6, value: 2 });
    const v3 = v2.remove('a');
    const v4 = v2.add({ id: 'a', start: 100, end: 200, value: 9 });

    expect(v0.size()).toBe(0);
    expect(ids(v1.overlap(0, 10))).toEqual(['a']);
    expect(ids(v2.overlap(0, 10))).toEqual(['a', 'b']);
    expect(ids(v3.overlap(0, 10))).toEqual(['b']);
    expect(v3.has('a')).toBe(false);
    expect(v2.has('a')).toBe(true);
    expect(v2.get('a')).toMatchObject({ start: 1, end: 5 });
    expect(ids(v4.overlap(0, 10))).toEqual(['b']); // v4 中 a 被覆盖到远处
    expect(ids(v2.overlap(0, 10))).toEqual(['a', 'b']); // v2 仍是旧数据
    v1.checkInvariants();
    v2.checkInvariants();
    v3.checkInvariants();
    v4.checkInvariants();
  });

  it('查询统计：空索引与空查询不访问节点', () => {
    const stats: QueryStats = { visited: 0 };
    expect(IntervalIndex.empty<number>().overlap(0, 10, stats)).toEqual([]);
    expect(stats.visited).toBe(0);
    const idx = IntervalIndex.empty<number>().add({ id: 'a', start: 0, end: 1, value: 1 });
    const s2: QueryStats = { visited: 0 };
    expect(idx.overlap(5, 5, s2)).toEqual([]);
    expect(s2.visited).toBe(0);
  });
});
