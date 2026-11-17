/** Paths refer to the server's host, which may differ from the browser's OS. */
export function isWindowsPath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || /^(?:\\\\|\/\/)[^/\\]+[/\\][^/\\]+/.test(path);
}
export function normalizeHostPath(path: string): string {
  const slash = path.trim().replace(/\\/g, '/');
  const prefix = slash.startsWith('//') ? '//' : slash.startsWith('/') ? '/' : '';
  const rest = slash.slice(prefix.length).replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const normalized = prefix + rest;
  return /^[a-z]:$/i.test(normalized) && /[\\/]$/.test(path.trim()) ? `${normalized}/` : normalized || '/';
}
export function parentHostPath(path: string): string {
  const normalized = normalizeHostPath(path);
  if (normalized === '/' || /^[a-z]:\/$/i.test(normalized) || /^\/\/[^/]+\/[^/]+$/.test(normalized)) return normalized;
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return normalized;
  if (slash === 0) return '/';
  if (slash === 2 && /^[a-z]:/i.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, slash);
}
export function joinHostPath(root: string, child: string): string {
  return `${normalizeHostPath(root).replace(/\/$/, '')}/${child}`;
}
