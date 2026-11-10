---
spec-id: PAGINATION-SPEC
version: 1
status: active
owner: order-platform
updated: 2026-10-28
---

# 订单列表分页规格

本规格约束 orderkit 的分页工具。order-api 的 `GET /orders` 直接调用 `paginate`，
前端按 `page_count` 渲染页码，因此两者都属于对外契约。

## SPEC-PAGE-001 页码从 1 开始

`page` 是从 1 开始的页码。`page=1` 返回第一条记录；`page=2` 返回第 `page_size+1`
条开始的记录。调用方不会传 0 基页码。

`page` 必须是大于等于 1 的整数。小于 1 或不是整数（例如 `0`、`-1`、`1.5`）属于
调用方错误，必须抛出 `ValueError`，不能静默返回空列表。

## SPEC-PAGE-002 page_size 取值范围

`page_size` 必须是 1 到 100（含）之间的整数。0、负数、大于 100 的值都属于调用方
错误，必须抛出 `ValueError`，不能静默截断或返回空列表。

## SPEC-PAGE-003 超出末页

当 `page` 超过最后一页时，返回空列表 `[]`。不得抛出 `IndexError`，也不得回退到
最后一页返回数据。

## SPEC-PAGE-004 页数计算

`page_count(total, page_size)` 返回 `ceil(total / page_size)`：

- `page_count(20, 10) == 2`（正好整除时不多算一页）
- `page_count(21, 10) == 3`
- `page_count(0, 10) == 0`

## SPEC-PAGE-005 兼容性约束

- 不修改传入的序列，返回一个新的 `list`。
- 函数名、参数顺序、返回值类型保持不变，现有调用方不需要改动。
- 允许接受 tuple、range 等任意可迭代对象。

## SPEC-PAGE-006 非法总数

`page_count` 的 `total` 为负数时属于调用方错误，必须抛出 `ValueError`。
