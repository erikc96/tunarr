/** Username and password from an HTTP Basic Authorization header, if valid. */
export function parseBasicAuth(
  header: string | undefined,
): { user: string; password: string } | undefined {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? '');
  if (!m) {
    return undefined;
  }
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i <= 0) {
    return undefined;
  }
  return { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
}
