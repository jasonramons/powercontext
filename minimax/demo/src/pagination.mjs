/**
 * Pagination helpers for the article listing API.
 * Spec: demo/specs/pagination.md
 */

/**
 * Slice one page out of a list.
 *
 * @param {unknown[]} items   source rows, never mutated
 * @param {number} page      1-based page number
 * @param {number} pageSize  rows per page, 1..100
 * @returns {unknown[]}
 */
export function paginate(items, page, pageSize) {
  const start = page * pageSize;
  const end = start + pageSize;
  return items.slice(start, end);
}

/**
 * Total page count for a list, used by the listing endpoint.
 */
export function pageCount(total, pageSize) {
  if (pageSize <= 0) {
    throw new RangeError('pageSize must be positive');
  }
  return Math.ceil(total / pageSize);
}
