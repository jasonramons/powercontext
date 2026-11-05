import { paginate, pageCount } from './pagination.mjs';

/**
 * Listing endpoint helper. Depends on the documented pagination contract:
 * page is 1-based, pageSize is capped at 100, out-of-range pages are empty.
 */
export function listArticles(articles, page, pageSize) {
  const rows = paginate(articles, page, pageSize);
  return {
    page,
    pageSize,
    totalPages: pageCount(articles.length, pageSize),
    rows,
  };
}
