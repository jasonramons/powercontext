"""订单列表分页。

``paginate`` 把订单序列切成一页返回，``page_count`` 给出总页数。
两个函数都被 order-api 的列表接口直接调用，签名属于对外契约。
"""


def paginate(items, page, page_size):
    """返回 ``items`` 的第 ``page`` 页。"""
    start = page * page_size
    return list(items)[start:start + page_size]


def page_count(total, page_size):
    """返回 ``total`` 条记录占用的页数。"""
    return total // page_size + 1
