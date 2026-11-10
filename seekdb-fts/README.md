# seekdb 赛题四 · 全文索引调优（IK 词典复用）

本目录是提交到**团队仓库**的 seekdb 源码改动，因为提测弹窗的「代码仓库地址」固定为团队仓库 `jasonramons/powercontext`，无法指向 seekdb fork。

## 改动

`src/storage/fts/ob_ik_ft_parser.{h,cpp}` —— 见 `patch/fts-ik-dict-cache.patch`（可 `git apply` 到 `oceanbase/seekdb` 同路径）。

**问题**：每次 `tokenize()` 都会重建三本 IK 词典（main / quantifier / stopword）：

```
hub->load_cache()  →  new ObFTRangeDict  →  dict->init()
```

而词典构建后是只读的。索引构建（每篇文档一次）和查询解析（每次查询一次）都在重复付这笔钱。

**改法**：加一个线程内词典 bundle（`thread_local ObIKDictCache`），首次调用时构建三本词典，后续解析器只借用指针；解析器析构时不再释放共享词典。用 `thread_local` 避免锁竞争。

## 实测（同机 A/B，`tools/benchmark/fts_large_bench.sh`，20k 文档）

| metric | before | after | 变化 |
|---|---|---|---|
| tokenize_ik_avg_ms | 0.4292 | 0.3833 | **−10.7%** |
| build_ik_all_sec | 13.169 | 12.759 | **−3.1%** |
| build_beng_en_sec | 5.579 | 5.377 | **−3.6%** |
| build_ik_content_sec | 10.101 | 10.104 | 0% |
| query_cn / beng / mixed / limit | 3.02 / 4.33 / 3.36 / 3.87 | 3.11 / 5.48 / 3.45 / 3.93 | 噪声范围 |

**正确性**：四类 MATCH 查询命中数 `8001 / 11000 / 7332 / 20`，与官方基线 JSON 完全一致，分词与查询语义未变。

## 应用方式

```bash
git clone https://github.com/oceanbase/seekdb.git
cd seekdb && git checkout 2026-competition   # 或对应冻结版本
git apply /path/to/patch/fts-ik-dict-cache.patch
./build.sh release --init && ./build.sh release --make -j8
```

应用前已核对：上游 `master` 与 `2026-competition` 的这两个文件逐字节一致，补丁可干净应用。
