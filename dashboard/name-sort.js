/**
 * Sorting people by surname — pure, no DOM, so it can be tested.
 *
 * A superintendent hunting for someone scans by surname. Sorting on the raw
 * string files everyone under their first name, which is barely better than not
 * sorting when the list runs to two hundred names.
 */

const NAME_SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v', 'md', 'phd']);

/**
 * Split a name into surname and forename keys.
 *
 * Procore returns several shapes and they have to sort together:
 *   "Chad Dawson"                            → dawson / chad
 *   "Tim Fishburn (Buffalo Construction)"    → fishburn / tim
 *   "Dawson, Chad"                           → dawson / chad
 *   "Robert Burns Jr."                       → burns / robert
 *   "Warehouse"                              → warehouse
 */
export function lastNameKey(fullName) {
  // Drop a trailing company parenthetical before looking for the surname.
  const bare = String(fullName || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
  if (!bare) return { last: '', first: '' };

  if (bare.includes(',')) {
    const [last, first = ''] = bare.split(',');
    return { last: last.trim().toLowerCase(), first: first.trim().toLowerCase() };
  }

  const parts = bare.split(/\s+/);
  let i = parts.length - 1;
  // "Robert Burns Jr." files under Burns, not Jr.
  while (i > 0 && NAME_SUFFIXES.has(parts[i].toLowerCase())) i--;
  return {
    last: (parts[i] || '').toLowerCase(),
    first: parts.slice(0, i).join(' ').toLowerCase(),
  };
}

/** Comparator for `{ name }` records. */
export function byLastName(a, b) {
  const ka = lastNameKey(a.name);
  const kb = lastNameKey(b.name);
  return ka.last.localeCompare(kb.last) || ka.first.localeCompare(kb.first);
}
