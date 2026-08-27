export function normalizeForSearch(value) {
  return value.trim().toLowerCase().replaceAll(' ', '-');
}

export function normalizeForUrl(value) {
  return value.trim().toLowerCase().replaceAll(' ', '-');
}
