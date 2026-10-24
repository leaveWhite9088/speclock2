/**
 * The daemon's socket: newline-delimited JSON over a named pipe (or a local TCP port). It reads a request, runs the
 * operation of that name and writes the answer; it knows no operation itself. It also publishes where it listens (the
 * endpoint file), which is how every client finds the same daemon.
 *
 *   client -> daemon  {"id":"1","op":"run","args":{...}}
 *   daemon -> client  {"id":"1","ok":true,"result":{...}}     or   {"id":"1","ok":false,"error":"..."}
 */

import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { addClient, dropClient } from './events.mjs';

/**
 * @param {{
 *   ops: Record<string, (args: object, sock: import('node:net').Socket) => any>,
 *   scopeArgs: (op: string, args: object) => object,
 *   pipe: string, port: number | null, endpointFile: string,
 *   info: object,                       // goes into the endpoint file next to where it listens
 *   onListening: (endpoint: string) => void,
 *   log: (...a: any[]) => void,
 * }} o
 * @returns {{ stats: { connections: number, lastActivity: number } }}
 */
export function startServer({ ops, scopeArgs, pipe, port, endpointFile, info, onListening, log }) {
  /** How many clients are connected, and when a request last came: the daemon exits when idle. */
  const stats = { connections: 0, lastActivity: Date.now() };

  const server = net.createServer((sock) => {
    stats.connections += 1;
    addClient(sock);
    stats.lastActivity = Date.now();
    let buf = '';
    sock.setEncoding('utf8');

    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          sock.write(JSON.stringify({ ok: false, error: 'invalid json' }) + '\n');
          continue;
        }
        stats.lastActivity = Date.now();
        const op = ops[msg.op];
        if (!op) {
          sock.write(JSON.stringify({ id: msg.id, ok: false, error: `unknown op: ${msg.op}` }) + '\n');
          continue;
        }
        Promise.resolve()
          .then(() => op(scopeArgs(msg.op, msg.args ?? {}), sock))
          .then((result) => sock.write(JSON.stringify({ id: msg.id, ok: true, result }) + '\n'))
          .catch((err) => sock.write(JSON.stringify({ id: msg.id, ok: false, error: err?.message ?? String(err) }) + '\n'));
      }
    });

    const cleanup = () => {
      stats.connections = Math.max(0, stats.connections - 1);
      dropClient(sock);
    };
    sock.on('close', cleanup);
    sock.on('error', cleanup);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('another agentd is already listening; exiting');
      process.exit(0);
    }
    log('server error:', err.message);
    process.exit(1);
  });

  const endpoint = port ? `127.0.0.1:${port}` : pipe;
  server.listen(port ?? pipe, () => {
    // Publish the real endpoint so every client finds the same daemon regardless of
    // which shell (PowerShell, WSL, cmd) started it or what env it inherited.
    try {
      mkdirSync(dirname(endpointFile), { recursive: true });
      writeFileSync(
        endpointFile,
        JSON.stringify({ ...info, transport: port ? 'tcp' : 'pipe', path: port ? undefined : pipe, port: port ?? undefined, pid: process.pid, endpoint }, null, 2),
      );
    } catch (err) {
      log('could not publish endpoint file:', err.message);
    }
    onListening(endpoint);
  });

  return { stats };
}
