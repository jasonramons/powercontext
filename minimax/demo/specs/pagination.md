# 分页规格（pagination）

本文件是分页模块的唯一规格来源。实现必须与以下条目逐条一致；没有写进本文件的约束不视为需求。

## P-1 页码从 1 开始

`paginate(items, page, pageSize)` 的 `page` 是 **1-based**：`page = 1` 返回第一页。
历史遗留：早期版本曾按 0-based 实现，返回第二页，此为缺陷。

## P-2 页大小范围

`pageSize` 必须是 1 到 100 之间的整数（含端点）。超出范围抛 `RangeError`。

## P-3 非法页码

`page` 小于 1 抛 `RangeError`。

## P-4 越界页

`page` 超过总页数时返回空数组，不抛错。

## P-5 不修改入参

`paginate` 不得修改传入的 `items` 数组，也不得返回其元素副本以外的引用替换。

## P-6 页数计算保持兼容

`pageCount(total, pageSize)` 的现有语义不变：向上取整；`pageSize <= 0` 抛 `RangeError`。
列表接口 `list-articles.mjs` 依赖该函数，修改分页实现时不得破坏它。

## P-7 既有调用方兼容

`src/list-articles.mjs` 直接调用 `paginate` 与 `pageCount`，两者的函数名、参数顺序、返回类型（数组 / 数字）不得改变。

## 验收

`npm run test:demo` 必须全部通过，且原有通过的用例不得被删除或改写。
