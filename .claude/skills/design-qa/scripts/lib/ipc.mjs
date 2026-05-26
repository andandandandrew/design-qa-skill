import net from 'node:net';
import { sessionSubPaths } from './paths.mjs';

/**
 * Newline-delimited JSON over a Unix domain socket.
 *
 * Server: server({sessionDir, handle}) returns the net.Server.
 * Handle is `async (msg) => reply`. Each connection is single-request/reply.
 *
 * Client: request(sessionDir, msg, {timeoutMs}) opens a connection, sends
 * one JSON line, reads one JSON line back, closes.
 */

export function server({ sessionDir, handle }) {
  const { socket: socketPath } = sessionSubPaths(sessionDir);
  const srv = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        conn.end(JSON.stringify({ ok: false, error: 'invalid json' }) + '\n');
        return;
      }
      Promise.resolve()
        .then(() => handle(msg))
        .then((reply) => conn.end(JSON.stringify({ ok: true, ...reply }) + '\n'))
        .catch((err) =>
          conn.end(JSON.stringify({ ok: false, error: String(err?.message || err) }) + '\n'),
        );
    });
    conn.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(socketPath, () => resolve(srv));
  });
}

export function request(sessionDir, msg, { timeoutMs = 30_000 } = {}) {
  const { socket: socketPath } = sessionSubPaths(sessionDir);
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buf = '';
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.destroy(); } catch {}
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('ipc timeout'))), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(JSON.stringify(msg) + '\n'));
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      let reply;
      try {
        reply = JSON.parse(line);
      } catch (err) {
        finish(() => reject(new Error('invalid reply json')));
        return;
      }
      finish(() => (reply.ok ? resolve(reply) : reject(new Error(reply.error || 'ipc error'))));
    });
    conn.on('error', (err) => finish(() => reject(err)));
    conn.on('end', () => finish(() => reject(new Error('connection closed without reply'))));
  });
}
