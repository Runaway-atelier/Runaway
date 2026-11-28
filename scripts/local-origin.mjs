export function localRequestURL(path, host, port) {
  const hostname = String(host || '').toLowerCase();
  if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(hostname)) return null;
  try {
    const origin = `http://${hostname}`;
    const url = new URL(path, origin);
    return url.origin === origin ? url : null;
  } catch { return null; }
}
