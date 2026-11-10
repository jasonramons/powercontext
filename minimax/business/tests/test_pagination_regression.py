"""回归测试：修复前后都必须通过的既有行为。

这里只断言与页码语义无关的契约（返回类型、入参不可变、空集合），
所以基线代码同样应当通过。
"""

from orderkit import page_count, paginate


def test_returns_a_list_copy_and_does_not_mutate_input():
    items = [{"order_id": "SO0001"}, {"order_id": "SO0002"}, {"order_id": "SO0003"}]
    before = [dict(row) for row in items]
    page = paginate(items, 1, 2)
    assert isinstance(page, list)
    assert page is not items
    assert items == before


def test_accepts_tuple_and_range_inputs():
    assert isinstance(paginate((1, 2, 3, 4, 5), 1, 2), list)
    assert isinstance(paginate(range(10), 1, 3), list)


def test_empty_collection_pages_to_empty_list():
    assert paginate([], 1, 10) == []
    assert paginate([], 99, 10) == []


def test_page_beyond_data_does_not_raise():
    assert paginate([1, 2, 3], 50, 2) == []


def test_page_count_of_zero_items():
    assert page_count(0, 5) == 0


def test_functions_keep_public_signature():
    import inspect

    assert list(inspect.signature(paginate).parameters) == ["items", "page", "page_size"]
    assert list(inspect.signature(page_count).parameters) == ["total", "page_size"]
