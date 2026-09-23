# Persistent interval index

持久化（不可变）区间索引：以稳定 id 为键的 AVL 平衡树，存储半开区间 `[start, end)`。

## 特性

- **持久化 / copy-on-write**：`add` / `remove` 返回新索引，旧版本查询不受新修改影响；
- **子树增强值**：每个节点维护 `maxEnd` / `minStart`，插入、删除与旋转均同步重算；
- **`overlap(start, end, stats?)`**：返回与查询区间重叠的所有项，按 `(start, end, id)` 稳定排序，利用 `maxEnd` / `minStart` 剪枝；
- **`contained(start, end, stats?)`**：返回完全包含于查询区间的项（`qs <= start` 且 `end <= qe`），同样排序并做包围盒剪枝；
- **`QueryStats.visited`**：公开查询访问的节点数，可验证稀疏查询不会全树扫描；
- **`checkInvariants()`**：校验 BST 顺序、AVL 平衡与增强值一致性，用于测试与调试。

## 空区间策略

- 允许存储 `start === end` 的空区间；`end < start` 或 NaN 端点抛出 `RangeError`；
- 空区间与任何区间都不重叠：`overlap` 永不返回空区间，空查询 `[p, p)` 返回空数组；
- 空区间 `[p, p)` 被认为完全包含于 `[qs, qe)` 当且仅当 `qs <= p <= qe`
  （`contained` 对所有项统一适用 `qs <= start && end <= qe`）。

## API

```ts
const v1 = IntervalIndex.empty<number>().add({ id: 'a', start: 1, end: 5, value: 42 });
const v2 = v1.add({ id: 'b', start: 3, end: 8, value: 7 }).remove('a');

v2.overlap(2, 4);            // => [{ id: 'b', ... }]（按 start, end, id 排序）
v2.contained(0, 10);         // => [{ id: 'b', ... }]
v1.has('a');                 // => true（旧版本不受影响）

const stats = { visited: 0 };
v2.overlap(2, 4, stats);     // stats.visited 为访问的节点数
```

`new IntervalIndex(items?)` 与 `IntervalIndex.from(items)` 可从条目集合构建；
相同 id 后出现的覆盖先出现的。`remove` 不存在的 id 返回同一实例。

## 复杂度与剪枝说明

- `add` / `remove`：`O(log n)`；查询：`O(log n + k)` 量级（k 为结果数）；
- 树以 id 为键，剪枝效果取决于 id 与坐标的相关性：id 按坐标顺序分配（如自增 id）时
  子树包围盒紧致、剪枝最有效；id 与位置完全无关时退化为全扫描（结果仍然正确）。

## 开发

```sh
npm install
npm test        # vitest：边界用例 + 旋转不变量 + 随机差分 + 剪枝计数
npm run build   # tsc
```
