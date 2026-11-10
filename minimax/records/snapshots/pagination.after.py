"""订单列表分页。

``paginate`` 把订单序列切成一页返回，``page_count`` 给出总页数。
两个函数都被 order-api 的列表接口直接调用，签名属于对外契约。
"""


def _validate_page_size(page_size):
    """校验分页大小。"""
    if (
        isinstance(page_size, bool)
        or not isinstance(page_size, int)
        or not 1 <= page_size <= 100
    ):
        raise ValueError("page_size must be an integer between 1 and 100")


def paginate(items, page, page_size):
    """返回 ``items`` 的第 ``page`` 页。"""
    if isinstance(page, bool) or not isinstance(page, int) or page < 1:
        raise ValueError("page must be an integer greater than or equal to 1")
    _validate_page_size(page_size)

    start = (page - 1) * page_size
    return list(items)[start:start + page_size]


def page_count(total, page_size):
    """返回 ``total`` 条记录占用的页数。"""
    _validate_page_size(page_size)
    if total < 0:
        raise ValueError("total must not be negative")
    return (total + page_size - 1) // page_size
