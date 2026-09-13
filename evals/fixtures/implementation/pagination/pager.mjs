/**
 * paginate slices `items` into 1-based pages of `perPage` entries.
 * page 1 is the first page; out-of-range pages return [].
 */
export function paginate(items, page, perPage) {
  if (perPage <= 0) throw new RangeError('perPage must be positive');
  const start = page * perPage;
  return items.slice(start, start + perPage);
}

export function pageCount(items, perPage) {
  if (perPage <= 0) throw new RangeError('perPage must be positive');
  return Math.ceil(items.length / perPage);
}
