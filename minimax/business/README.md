# orderkit（业务工程）

这是「被修改的业务工程」，不是上下文模块本身。它是一个可以直接运行的 Python
包，只有一个分页工具模块和一套测试：

```
business/
├── app/orderkit/pagination.py        # 基线实现（本任务要修改的文件）
└── tests/
    ├── test_pagination_target.py     # 目标功能测试：修改前失败，修改后通过
    └── test_pagination_regression.py # 回归测试：修改前后都必须通过
```

运行测试（在 `minimax/` 目录下）：

```bash
PYTHONPATH=business/app python -m pytest business/tests -q
```

基线是被订单平台记录的真实缺陷：`paginate` 把 `page` 当成 0 基页码，`page_count`
整除时多算一页，且缺少 `page_size` / `total` 的边界校验。目标测试断言的是
`materials/specs/pagination.spec.md` 规定的行为。
