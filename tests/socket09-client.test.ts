import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import {
  OverleafRealtimeClient,
  decodeSocket09Packet,
  encodeSocket09Event,
} from '../src/overleaf/socket09-client.js';
import type { OverleafConfig } from '../src/config.js';
import type { OverleafHttpClient } from '../src/overleaf/http-client.js';

function createMockHttpClient(): OverleafHttpClient {
  return {
    ensureAuthenticated: async () => {},
    getCookieHeader: () => 'overleaf.sid=test-sid',
    invalidateSession: () => {},
  } as unknown as OverleafHttpClient;
}

describe('Socket09Codec', () => {
  it('encodes and decodes Socket.IO 0.9 event and ack packets', () => {
    const encoded = encodeSocket09Event('joinDoc', ['d1', -1, { encodeRanges: false }], 1);
    expect(encoded).toBe('5:1+::{"name":"joinDoc","args":["d1",-1,{"encodeRanges":false}]}');

    expect(decodeSocket09Packet('2::')).toEqual({ type: 2 });
    expect(decodeSocket09Packet('1::')).toEqual({ type: 1 });
    expect(decodeSocket09Packet('6:::1+[null,42]')).toEqual({
      type: 6,
      ackId: 1,
      args: [null, 42],
    });
  });
});

describe('OverleafRealtimeClient', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.close();
    }
  });

  async function startMockServer(
    onSocket: (ws: import('ws').WebSocket, reqUrl: string, headers: http.IncomingHttpHeaders) => void
  ): Promise<{ url: string; handshakeUrls: string[]; handshakeCookies: string[] }> {
    const handshakeUrls: string[] = [];
    const handshakeCookies: string[] = [];

    const httpServer = http.createServer((req, res) => {
      if (req.url?.startsWith('/socket.io/1/?')) {
        handshakeUrls.push(req.url);
        handshakeCookies.push(String(req.headers.cookie ?? ''));
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('sid123:60:60:websocket,xhr-polling');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (ws, req) => {
      onSocket(ws, req.url ?? '', req.headers);
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const addr = httpServer.address() as { port: number };
    servers.push({
      close: () =>
        new Promise<void>((resolve) => {
          wss.close(() => httpServer.close(() => resolve()));
        }),
    });

    return {
      url: `http://127.0.0.1:${addr.port}`,
      handshakeUrls,
      handshakeCookies,
    };
  }

  it('connects with ?projectId=p1, resolves joinProjectResponse, and replies to heartbeats', async () => {
    let sawHeartbeatReply = false;
    const srv = await startMockServer((ws, reqUrl, headers) => {
      expect(reqUrl).toContain('/socket.io/1/websocket/sid123');
      expect(reqUrl).toContain('projectId=p1');
      expect(headers.cookie).toContain('overleaf.sid=test-sid');

      ws.on('message', (data) => {
        if (data.toString() === '2::') {
          sawHeartbeatReply = true;
        }
      });

      ws.send('1::');
      ws.send('2::');
      ws.send(
        '5:::' +
          JSON.stringify({
            name: 'joinProjectResponse',
            args: [
              {
                publicId: 'P.1',
                project: {
                  _id: 'p1',
                  name: 'Thesis',
                  rootFolder: [{ _id: 'root1', name: 'rootFolder', docs: [], fileRefs: [], folders: [] }],
                },
                permissionsLevel: 'owner',
                protocolVersion: 2,
              },
            ],
          })
      );
    });

    const cfg: OverleafConfig = { url: srv.url, email: 'a@b.c', password: 'pw' };
    const client = new OverleafRealtimeClient(cfg, createMockHttpClient());
    const project = await client.joinProject('p1');

    expect(srv.handshakeUrls[0]).toContain('projectId=p1');
    expect(srv.handshakeCookies[0]).toContain('overleaf.sid=test-sid');
    expect(project._id).toBe('p1');
    expect(project.name).toBe('Thesis');
    // Allow heartbeat tick to process
    await new Promise((r) => setTimeout(r, 20));
    expect(sawHeartbeatReply).toBe(true);
    client.close();
  });

  it('rejects cleanly when server emits connectionRejected', async () => {
    const srv = await startMockServer((ws) => {
      ws.send('1::');
      ws.send(
        '5:::' +
          JSON.stringify({
            name: 'connectionRejected',
            args: [{ message: 'invalid session' }],
          })
      );
    });

    const cfg: OverleafConfig = { url: srv.url, email: 'a@b.c', password: 'pw' };
    const client = new OverleafRealtimeClient(cfg, createMockHttpClient());
    await expect(client.joinProject('p1')).rejects.toThrow(/invalid session/);
    client.close();
  });

  it('decodes Thai UTF-8 lines for standard joinDoc and preserves raw UTF-8 for history-ot', async () => {
    const srv = await startMockServer((ws) => {
      ws.send('1::');
      ws.send(
        '5:::' +
          JSON.stringify({
            name: 'joinProjectResponse',
            args: [{ publicId: 'P.1', project: { _id: 'p1', name: 'P', rootFolder: [] } }],
          })
      );
      ws.on('message', (raw) => {
        const pkt = decodeSocket09Packet(raw.toString());
        if (pkt.type === 5 && pkt.name === 'joinDoc') {
          const docId = pkt.args[0];
          if (docId === 'd-std') {
            const encodedLines = ['\\section{บทนำ}', 'สวัสดีครับ'].map((l) =>
              unescape(encodeURIComponent(l))
            );
            ws.send(`6:::${pkt.id}+` + JSON.stringify([null, encodedLines, 7, [], {}, 'standard', { canSkipLeaveDoc: true }]));
          } else if (docId === 'd-hot') {
            const rawLines = ['\\section{บทนำ}', '100% ASCII & ไทย'];
            ws.send(`6:::${pkt.id}+` + JSON.stringify([null, rawLines, 9, [], {}, 'history-ot', { canSkipLeaveDoc: true }]));
          }
        }
      });
    });

    const cfg: OverleafConfig = { url: srv.url, email: 'a@b.c', password: 'pw' };
    const client = new OverleafRealtimeClient(cfg, createMockHttpClient());

    const stdDoc = await client.joinDoc('p1', 'd-std');
    expect(stdDoc).toEqual({
      content: '\\section{บทนำ}\nสวัสดีครับ',
      version: 7,
      docType: 'standard',
    });

    const hotDoc = await client.joinDoc('p1', 'd-hot');
    expect(hotDoc).toEqual({
      content: '\\section{บทนำ}\n100% ASCII & ไทย',
      version: 9,
      docType: 'history-ot',
    });

    client.close();
  });

  it('waits for otUpdateApplied and rejects on async otUpdateError after queue ack', async () => {
    const receivedUpdates: unknown[] = [];
    const srv = await startMockServer((ws) => {
      ws.send('1::');
      ws.send(
        '5:::' +
          JSON.stringify({
            name: 'joinProjectResponse',
            args: [{ publicId: 'P.1', project: { _id: 'p1', name: 'P', rootFolder: [] } }],
          })
      );
      ws.on('message', (raw) => {
        const pkt = decodeSocket09Packet(raw.toString());
        if (pkt.type === 5 && pkt.name === 'applyOtUpdate') {
          receivedUpdates.push(pkt.args);
          const update = pkt.args[1] as { v: number; doc: string };
          // Real Overleaf sends empty queue ack [null] first, then otUpdateApplied or otUpdateError
          ws.send(`6:::${pkt.id}+[null]`);
          if (update.v === 7) {
            ws.send(
              '5:::' +
                JSON.stringify({
                  name: 'otUpdateApplied',
                  args: [{ v: 7, doc: update.doc }],
                })
            );
          } else {
            ws.send(
              '5:::' +
                JSON.stringify({
                  name: 'otUpdateError',
                  args: ['DeleteMismatchError', { doc_id: update.doc, error: 'DeleteMismatchError' }],
                })
            );
          }
        }
      });
    });

    const cfg: OverleafConfig = { url: srv.url, email: 'a@b.c', password: 'pw' };
    const client = new OverleafRealtimeClient(cfg, createMockHttpClient());

    const nextV = await client.applyOtUpdate('p1', 'd1', { v: 7, op: [{ p: 0, i: 'hi' }] });
    expect(nextV).toBe(8);
    expect(receivedUpdates[0]).toEqual(['d1', { doc: 'd1', v: 7, op: [{ p: 0, i: 'hi' }] }]);

    await expect(
      client.applyOtUpdate('p1', 'd1', { v: 8, op: [{ p: 0, i: 'fail' }] })
    ).rejects.toThrow(/DeleteMismatchError/);

    client.close();
  });

  it('deduplicates concurrent joinProject calls and updates cached tree on Socket.IO broadcasts', async () => {
    let socketCount = 0;
    let activeWs: import('ws').WebSocket | undefined;
    const srv = await startMockServer((ws) => {
      socketCount++;
      activeWs = ws;
      ws.send('1::');
      setTimeout(() => {
        ws.send(
          '5:::' +
            JSON.stringify({
              name: 'joinProjectResponse',
              args: [
                {
                  publicId: 'P.1',
                  project: {
                    _id: 'p1',
                    name: 'P',
                    rootDoc_id: 'd1',
                    rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [] }],
                  },
                },
              ],
            })
        );
      }, 15);
    });

    const cfg: OverleafConfig = { url: srv.url, email: 'a@b.c', password: 'pw' };
    const client = new OverleafRealtimeClient(cfg, createMockHttpClient());

    const [pA, pB] = await Promise.all([client.joinProject('p1'), client.joinProject('p1')]);
    expect(socketCount).toBe(1);
    expect(pA._id).toBe('p1');
    expect(pB._id).toBe('p1');

    // Emit live tree mutation broadcasts
    activeWs!.send('5:::' + JSON.stringify({ name: 'reciveNewFolder', args: ['root', { _id: 'f1', name: 'sec' }] }));
    activeWs!.send('5:::' + JSON.stringify({ name: 'reciveNewDoc', args: ['f1', { _id: 'd2', name: 'ch1.tex' }] }));
    activeWs!.send('5:::' + JSON.stringify({ name: 'reciveEntityRename', args: ['d2', 'intro.tex'] }));
    activeWs!.send('5:::' + JSON.stringify({ name: 'setRootDoc', args: ['d2'] }));

    await new Promise((r) => setTimeout(r, 20));
    const updated = await client.joinProject('p1');
    expect(updated.rootDoc_id).toBe('d2');
    expect(updated.rootFolder[0].folders?.[0].docs?.[0]).toEqual({ _id: 'd2', name: 'intro.tex' });

    client.close();
  });
});
