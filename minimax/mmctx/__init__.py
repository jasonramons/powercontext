"""mmctx — 面向 SDD 的工程上下文模块。

三个外部依赖各司其职：
- seekdb（嵌入式）：存放规格/代码/测试片段与向量索引，检索结果用于构造上下文；
- MiniMax：根据上下文生成代码修改；
- PowerContext：以 scoped Memory 保存任务进展，重启后读回并继续使用。
"""

__version__ = "1.0.0"
