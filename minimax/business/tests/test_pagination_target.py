"""目标功能测试：本次任务要求实现的对外行为。

这些用例在修复前的基线代码上失败（断言不符），修复后必须全部通过。
"""

import pytest

from orderkit import page_count, paginate


def _orders(n):
    return [{"order_id": f"SO{i:04d}"} for i in range(n)]


def test_first_page_is_one_based():
    page = paginate(_orders(25), 1, 10)
    assert [row["order_id"] for row in page] == [f"SO{i:04d}" for i in range(10)]


def test_second_page_starts_after_first_page():
    page = paginate(_orders(25), 2, 10)
    assert [row["order_id"] for row in page] == [f"SO{i:04d}" for i in range(10, 20)]


def test_last_partial_page():
    page = paginate(_orders(25), 3, 10)
    assert [row["order_id"] for row in page] == [f"SO{i:04d}" for i in range(20, 25)]


def test_page_beyond_last_page_is_empty():
    assert paginate(_orders(25), 99, 10) == []


@pytest.mark.parametrize("page", [0, -1, -7])
def test_page_below_one_is_rejected(page):
    with pytest.raises(ValueError):
        paginate(_orders(25), page, 10)


@pytest.mark.parametrize("page_size", [0, -5, 101, 1000])
def test_page_size_out_of_range_is_rejected(page_size):
    with pytest.raises(ValueError):
        paginate(_orders(25), 1, page_size)


@pytest.mark.parametrize("page_size", [1, 100])
def test_page_size_bounds_are_inclusive(page_size):
    assert paginate(_orders(150), 1, page_size) == _orders(150)[:page_size]


def test_page_count_rounds_up():
    assert page_count(25, 10) == 3
    assert page_count(21, 10) == 3


def test_page_count_exact_multiple_is_not_rounded_up():
    assert page_count(20, 10) == 2
    assert page_count(100, 10) == 10


def test_page_count_of_empty_collection_is_zero():
    assert page_count(0, 10) == 0


@pytest.mark.parametrize("total", [-1, -30])
def test_page_count_rejects_negative_total(total):
    # SPEC-PAGE-006：total 为负数属于调用方错误，必须显式失败。
    with pytest.raises(ValueError):
        page_count(total, 10)
