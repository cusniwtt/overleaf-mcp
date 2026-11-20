import WebSocket from 'ws';
import type { OverleafConfig } from '../config.js';
import { OverleafMcpError } from '../errors.js';
import type { OverleafHttpClient } from './http-client.js';

export type OtOp = { p: number; i: string } | { p: number; d: string };

export interface OverleafDocRef {
  _id: string;
  name: string;
}

export interface OverleafFileRef {
  _id: string;
  name: string;
}

export interface OverleafFolderNode {
  _id: string;
  name: string;
  docs?: OverleafDocRef[];
  fileRefs?: OverleafFileRef[];
  folders?: OverleafFolderNode[];
}

export interface OverleafProjectPayload {
  _id: string;
  name: string;
  rootDoc_id?: string;
  rootFolder: OverleafFolderNode[];
}

export interface JoinedDoc {
  content: string;
  version: number;
  docType: string;
}

export type Socket09Packet =
  | { type: 0 }
  | { type: 1 }
  | { type: 2 }
  | { type: 5; id?: number; name: string; args: unknown[] }
  | { type: 6; ackId: number; args: unknown[] }
  | { type: 7; data: string }
  | { type: 'unknown'; code: number; raw: string };

export function encodeSocket09Event(name: string, args: unknown[], id?: number): string {
  const idPart = id !== undefined ? `${id}+` : '';
  return `5:${idPart}::${JSON.stringify({ name, args })}`;
}

export function decodeSocket09Packet(raw: string): Socket09Packet {
  const firstColon = raw.indexOf(':');
  if (firstColon === -1) {
    return { type: 'unknown', code: -1, raw };
  }
  const type = Number(raw.slice(0, firstColon));
  const rest = raw.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  if (secondColon === -1) {
    return { type: 'unknown', code: type, raw };
  }
  const idStr = rest.slice(0, secondColon);
  const afterId = rest.slice(secondColon + 1);
  const thirdColon = afterId.indexOf(':');
  const data = thirdColon === -1 ? '' : afterId.slice(thirdColon + 1);

  if (type === 0) return { type: 0 };
  if (type === 1) return { type: 1 };
  if (type === 2) return { type: 2 };
  if (type === 7) return { type: 7, data };

  if (type === 5) {
    const cleanId = idStr.endsWith('+') ? idStr.slice(0, -1) : idStr;
    const id = cleanId ? Number(cleanId) : undefined;
    const parsed = JSON.parse(data) as { name: string; args?: unknown[] };
    return {
      type: 5,
      ...(id !== undefined && !Number.isNaN(id) ? { id } : {}),
      name: parsed.name,
      args: parsed.args ?? [],
    };
  }

  if (type === 6) {
    const plus = data.indexOf('+');
    if (plus === -1) {
      return { type: 6, ackId: Number(data), args: [] };
    }
    const ackId = Number(data.slice(0, plus));
    const jsonPart = data.slice(plus + 1);
    const args = jsonPart ? (JSON.parse(jsonPart) as unknown[]) : [];
    return { type: 6, ackId, args };
  }

  return { type: 'unknown', code: type, raw };
}

function decodeLatin1Utf8(text: string): string {
  return Buffer.from(text, 'latin1').toString('utf8');
}

interface PendingAck {
  resolve: (args: unknown[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ProjectSession {
  ws: WebSocket;
  projectPromise: Promise<OverleafProjectPayload>;
  nextId: number;
  pendingAcks: Map<number, PendingAck>;
}

/**
 * Socket.IO v0.9 WebSocket client for Overleaf CE's real-time service.
 */
export class OverleafRealtimeClient {
  private readonly config: OverleafConfig;
  private readonly httpClient: OverleafHttpClient;
  private readonly fetchImpl: typeof fetch;
  private readonly sessions = new Map<string, ProjectSession>();
  private readonly ackTimeoutMs: number;

  constructor(
    config: OverleafConfig,
    httpClient: OverleafHttpClient,
    options?: { fetchImpl?: typeof fetch; ackTimeoutMs?: number }
  ) {
    this.config = config;
    this.httpClient = httpClient;
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.ackTimeoutMs = options?.ackTimeoutMs ?? 15_000;
  }

  private async openSession(projectId: string, allowReauth = true): Promise<ProjectSession> {
    await this.httpClient.ensureAuthenticated();
    const cookieHeader = this.httpClient.getCookieHeader();

    const handshakeUrl = `${this.config.url}/socket.io/1/?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;
    const handshakeRes = await this.fetchImpl(handshakeUrl, {
      method: 'GET',
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
    if (!handshakeRes.ok) {
      if ((handshakeRes.status === 401 || handshakeRes.status === 403) && allowReauth) {
        this.httpClient.invalidateSession();
        return this.openSession(projectId, false);
      }
      throw new OverleafMcpError(
        `Socket.IO handshake failed with HTTP ${handshakeRes.status}`,
        'REALTIME_ERROR'
      );
    }

    const handshakeText = (await handshakeRes.text()).trim();
    const [sid, , , transports] = handshakeText.split(':');
    if (!sid || !transports?.includes('websocket')) {
      throw new OverleafMcpError(
        `Unexpected Socket.IO handshake response: ${handshakeText}`,
        'REALTIME_ERROR'
      );
    }

    const wsBase = this.config.url.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    const wsUrl = `${wsBase}/socket.io/1/websocket/${encodeURIComponent(sid)}?projectId=${encodeURIComponent(projectId)}`;

    const ws = new WebSocket(wsUrl, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });

    const pendingAcks = new Map<number, PendingAck>();
    let resolveProject!: (p: OverleafProjectPayload) => void;
    let rejectProject!: (err: Error) => void;
    let settled = false;

    const projectPromise = new Promise<OverleafProjectPayload>((res, rej) => {
      resolveProject = (p) => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          res(p);
        }
      };
      rejectProject = (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          rej(err);
        }
      };
    });

    const connectTimer = setTimeout(() => {
      rejectProject(new OverleafMcpError('Timed out waiting for Overleaf joinProjectResponse', 'REALTIME_TIMEOUT'));
      ws.close();
    }, this.ackTimeoutMs);

    const failAll = (err: Error) => {
      this.sessions.delete(projectId);
      rejectProject(err);
      for (const [, pending] of pendingAcks) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      pendingAcks.clear();
    };

    const session: ProjectSession = {
      ws,
      projectPromise,
      nextId: 1,
      pendingAcks,
    };
    this.sessions.set(projectId, session);

    ws.on('message', (rawData) => {
      const text = typeof rawData === 'string' ? rawData : rawData.toString('utf8');
      let pkt: Socket09Packet;
      try {
        pkt = decodeSocket09Packet(text);
      } catch {
        return;
      }

      if (pkt.type === 2) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('2::');
        }
        return;
      }

      if (pkt.type === 6) {
        const pending = pendingAcks.get(pkt.ackId);
        if (pending) {
          pendingAcks.delete(pkt.ackId);
          clearTimeout(pending.timer);
          pending.resolve(pkt.args);
        }
        return;
      }

      if (pkt.type === 5) {
        if (pkt.name === 'joinProjectResponse') {
          const payload = pkt.args[0] as { project?: OverleafProjectPayload } | undefined;
          if (payload?.project) {
            resolveProject(payload.project);
          } else {
            failAll(new OverleafMcpError('joinProjectResponse missing project payload', 'REALTIME_ERROR'));
          }
        } else if (pkt.name === 'connectionRejected') {
          const info = pkt.args[0] as { message?: string } | undefined;
          const msg = info?.message ?? 'connection rejected';
          if (msg.toLowerCase().includes('session')) {
            this.httpClient.invalidateSession();
          }
          failAll(new OverleafMcpError(`Overleaf realtime rejected connection: ${msg}`, 'REALTIME_REJECTED'));
          ws.close();
        } else if (pkt.name === 'reconnectGracefully') {
          failAll(new OverleafMcpError('Overleaf requested graceful reconnect', 'REALTIME_DISCONNECTED'));
          ws.close();
        } else if (pkt.name === 'otUpdateError') {
          const errPayload = pkt.args[1] ?? pkt.args[0];
          const errMsg = typeof errPayload === 'string' ? errPayload : JSON.stringify(errPayload);
          failAll(new OverleafMcpError(`Overleaf OT update error: ${errMsg}`, 'OT_ERROR'));
          ws.close();
        }
      }
    });

    ws.on('error', (err) => {
      failAll(new OverleafMcpError(`Overleaf WebSocket error: ${err.message}`, 'REALTIME_ERROR'));
    });

    ws.on('close', () => {
      failAll(new OverleafMcpError('Overleaf WebSocket closed', 'REALTIME_DISCONNECTED'));
    });

    try {
      await session.projectPromise;
      return session;
    } catch (err) {
      if (
        allowReauth &&
        err instanceof OverleafMcpError &&
        err.code === 'REALTIME_REJECTED'
      ) {
        this.httpClient.invalidateSession();
        return this.openSession(projectId, false);
      }
      throw err;
    }
  }

  private async getSession(projectId: string): Promise<ProjectSession> {
    const existing = this.sessions.get(projectId);
    if (existing && existing.ws.readyState !== WebSocket.CLOSED && existing.ws.readyState !== WebSocket.CLOSING) {
      await existing.projectPromise;
      return existing;
    }
    this.sessions.delete(projectId);
    return this.openSession(projectId);
  }

  private async emitWithAck(
    session: ProjectSession,
    name: string,
    args: unknown[]
  ): Promise<unknown[]> {
    const id = session.nextId++;
    const packet = encodeSocket09Event(name, args, id);
    return new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingAcks.delete(id);
        reject(new OverleafMcpError(`Socket.IO ${name} timed out`, 'REALTIME_TIMEOUT'));
      }, this.ackTimeoutMs);

      session.pendingAcks.set(id, { resolve, reject, timer });
      try {
        session.ws.send(packet);
      } catch (err) {
        clearTimeout(timer);
        session.pendingAcks.delete(id);
        reject(new OverleafMcpError(`Socket.IO send failed: ${(err as Error).message}`, 'REALTIME_ERROR'));
      }
    });
  }

  async joinProject(projectId: string): Promise<OverleafProjectPayload> {
    const session = await this.getSession(projectId);
    return session.projectPromise;
  }

  async joinDoc(projectId: string, docId: string): Promise<JoinedDoc> {
    const session = await this.getSession(projectId);
    const ack = await this.emitWithAck(session, 'joinDoc', [
      docId,
      -1,
      { encodeRanges: false },
    ]);
    const [err, lines, version, , , docType] = ack as [
      { message?: string } | string | null,
      string[] | undefined,
      number | undefined,
      unknown,
      unknown,
      string | undefined,
    ];
    if (err) {
      const msg = typeof err === 'string' ? err : err.message ?? JSON.stringify(err);
      throw new OverleafMcpError(`joinDoc failed: ${msg}`, 'REALTIME_ERROR');
    }

    const typeStr = docType ?? 'standard';
    const decodedLines = (lines ?? []).map((line) =>
      typeStr === 'history-ot' ? line : decodeLatin1Utf8(line)
    );
    return {
      content: decodedLines.join('\n'),
      version: version ?? 0,
      docType: typeStr,
    };
  }

  async applyOtUpdate(
    projectId: string,
    docId: string,
    update: { v: number; op: OtOp[] }
  ): Promise<void> {
    const session = await this.getSession(projectId);
    const ack = await this.emitWithAck(session, 'applyOtUpdate', [
      docId,
      {
        doc: docId,
        v: update.v,
        op: update.op,
      },
    ]);
    const [err] = ack as [{ message?: string } | string | null];
    if (err) {
      const msg = typeof err === 'string' ? err : err.message ?? JSON.stringify(err);
      throw new OverleafMcpError(`applyOtUpdate failed: ${msg}`, 'OT_ERROR');
    }
  }

  close(projectId?: string): void {
    if (projectId) {
      const s = this.sessions.get(projectId);
      if (s) {
        this.sessions.delete(projectId);
        s.ws.close();
      }
      return;
    }
    for (const [pid, s] of this.sessions) {
      this.sessions.delete(pid);
      s.ws.close();
    }
  }
}
