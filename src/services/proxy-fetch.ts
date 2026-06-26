// HTTPS GET through an HTTP CONNECT proxy, using raw Cloudflare Workers TCP sockets.
//
// Why: partners.bitunix.com sits behind Cloudflare, and its WAF returns 403 to a DIRECT
// Cloudflare Worker fetch (Cloudflare-to-Cloudflare egress is flagged). The owner's
// residential proxy reaches it fine (verified via curl: cloudflare 400, ipify 200), so we
// tunnel the Bitunix request through that proxy. fetch() in Workers can't use a proxy, but
// the raw TCP Sockets API (connect + startTls) can. Returns { status, body }.
// Any failure throws — verifyUid catches it and falls back to manual review.

import { connect } from 'cloudflare:sockets';

export interface ProxyResponse {
  status: number;
  body: string;
}

function indexOfCRLFCRLF(a: Uint8Array): number {
  for (let i = 0; i + 3 < a.length; i++) {
    if (a[i] === 13 && a[i + 1] === 10 && a[i + 2] === 13 && a[i + 3] === 10) return i;
  }
  return -1;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// De-chunk a chunked HTTP/1.1 body at the BYTE level (size lines are ASCII hex).
function dechunk(body: Uint8Array): Uint8Array {
  const out: number[] = [];
  const dec = new TextDecoder();
  let i = 0;
  while (i < body.length) {
    let j = i;
    while (j + 1 < body.length && !(body[j] === 13 && body[j + 1] === 10)) j++;
    const size = parseInt(dec.decode(body.slice(i, j)).trim().split(';')[0], 16);
    if (isNaN(size) || size === 0) break;
    const start = j + 2;
    for (let k = start; k < start + size && k < body.length; k++) out.push(body[k]);
    i = start + size + 2;
  }
  return new Uint8Array(out);
}

export async function httpsGetViaProxy(
  proxyUrl: string,
  targetHost: string,
  targetPath: string,
  headers: Record<string, string>,
): Promise<ProxyResponse> {
  const p = new URL(proxyUrl); // http://user:pass@host:port
  const enc = new TextEncoder();

  const socket = connect(
    { hostname: p.hostname, port: Number(p.port) || 8000 },
    { secureTransport: 'starttls', allowHalfOpen: false },
  );
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  // 1) CONNECT handshake to the proxy (plaintext).
  let connectReq = `CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n`;
  if (p.username) {
    const auth = btoa(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`);
    connectReq += `Proxy-Authorization: Basic ${auth}\r\n`;
  }
  connectReq += '\r\n';
  await writer.write(enc.encode(connectReq));

  const connChunks: Uint8Array[] = [];
  while (indexOfCRLFCRLF(concat(connChunks)) < 0) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) connChunks.push(value);
  }
  const connText = new TextDecoder().decode(concat(connChunks));
  if (!/^HTTP\/1\.[01] 200/.test(connText)) {
    try {
      await writer.close();
    } catch {
      /* ignore */
    }
    throw new Error(`proxy CONNECT failed: ${connText.slice(0, 60)}`);
  }
  reader.releaseLock();
  writer.releaseLock();

  // 2) Upgrade the tunnel to TLS for the target host.
  const tls = socket.startTls({ expectedServerHostname: targetHost });
  const tw = tls.writable.getWriter();
  const tr = tls.readable.getReader();

  // 3) Send the HTTPS GET over the TLS tunnel (Connection: close → read to EOF).
  let req = `GET ${targetPath} HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n`;
  for (const [k, v] of Object.entries(headers)) req += `${k}: ${v}\r\n`;
  req += '\r\n';
  await tw.write(enc.encode(req));

  // 4) Read the full response.
  const respChunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await tr.read();
    if (done) break;
    if (value) respChunks.push(value);
  }
  try {
    await tw.close();
  } catch {
    /* ignore */
  }

  const all = concat(respChunks);
  const sep = indexOfCRLFCRLF(all);
  const headText = new TextDecoder().decode(sep >= 0 ? all.slice(0, sep) : all);
  let bodyBytes = sep >= 0 ? all.slice(sep + 4) : new Uint8Array(0);
  const m = headText.match(/^HTTP\/1\.[01] (\d{3})/);
  const status = m ? Number(m[1]) : 0;
  if (/transfer-encoding:\s*chunked/i.test(headText)) {
    bodyBytes = dechunk(bodyBytes);
  }
  return { status, body: new TextDecoder().decode(bodyBytes) };
}
