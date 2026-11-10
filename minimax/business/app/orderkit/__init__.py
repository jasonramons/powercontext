"""orderkit — 订单服务里被多个模块复用的分页工具。"""

from .pagination import page_count, paginate

__all__ = ["page_count", "paginate"]
