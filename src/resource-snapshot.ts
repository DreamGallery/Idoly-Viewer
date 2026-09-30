/** A browser session follows one published snapshot. Local APIs omit the header. */
let release: string | null = null;
export function acceptResourceSnapshot(response: Response) {
  const value = response.headers.get('X-Idoly-Release');
  if (value && /^[A-Za-z0-9_-]+$/.test(value)) release ??= value;
}
export function resourceCatalogBase(): string { return release ? '/catalog/releases/' + release : '/catalog'; }
export function resourceUrl(path: string): string {
  if (!release || !/^\/(?:data\/|images\/|api\/(?:media|source|script)\/|catalog\/)/.test(path) || path.startsWith('/catalog/releases/')) return path;
  const url = new URL(path, 'https://snapshot.invalid');
  url.searchParams.set('release', release);
  return url.pathname + url.search + url.hash;
}
export function snapshotJson<T>(value: T): T {
  if (typeof value === 'string') return resourceUrl(value) as T;
  if (Array.isArray(value)) return value.map(snapshotJson) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotJson(item)])) as T;
  return value;
}
export async function resourceJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response = await fetch(resourceUrl(path), init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  acceptResourceSnapshot(response);
  // Concurrent bootstrap requests may straddle publication; the first response wins.
  if (release && response.headers.get('X-Idoly-Release') !== release) {
    response = await fetch(resourceUrl(path), init);
    if (!response.ok || response.headers.get('X-Idoly-Release') !== release) throw new Error('资源版本不一致，请刷新页面');
  }
  return snapshotJson(await response.json()) as T;
}
