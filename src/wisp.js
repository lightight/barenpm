import { WebSocketServer } from 'ws';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';

const CONNECT_TYPE = {
    CONNECT: 0x01,
    DATA: 0x02,
    CONTINUE: 0x03,
    CLOSE: 0x04
};

const STREAM_TYPE = {
    TCP: 0x01,
    UDP: 0x02
};

function wispFrameParser(data) {
    const uint8arrayView = new Uint8Array(data);
    const dataView = new DataView(uint8arrayView.buffer, uint8arrayView.byteOffset, uint8arrayView.byteLength);
    const type = dataView.getUint8(0);
    const streamID = dataView.getUint32(1, true);
    const payload = uint8arrayView.slice(5);
    return { type, streamID, payload };
}

function connectPacketParser(payload) {
    const uint8array = new Uint8Array(payload);
    const dataview = new DataView(uint8array.buffer, uint8array.byteOffset, uint8array.byteLength);
    const streamType = dataview.getUint8(0);
    const port = dataview.getUint16(1, true);
    const hostname = new TextDecoder("utf8").decode(uint8array.slice(3));
    return { streamType, port, hostname };
}

function continuePacketMaker(streamID, queue) {
    const buffer = Buffer.alloc(9);
    buffer.writeUint8(CONNECT_TYPE.CONTINUE, 0);
    buffer.writeUint32LE(streamID, 1);
    buffer.writeUint32LE(queue, 5);
    return buffer;
}

function closePacketMaker(streamID, reason) {
    const buffer = Buffer.alloc(6);
    buffer.writeUint8(CONNECT_TYPE.CLOSE, 0);
    buffer.writeUint32LE(streamID, 1);
    buffer.writeUint8(reason, 5);
    return buffer;
}

function dataPacketMaker(streamID, data) {
    const header = Buffer.alloc(5);
    header.writeUint8(CONNECT_TYPE.DATA, 0);
    header.writeUint32LE(streamID, 1);
    return Buffer.concat([header, data]);
}

export function createWispServer() {
    const wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws) => {
        ws.connections = new Map();
        ws.send(continuePacketMaker(0, 127));

        ws.on('message', async (message, isBinary) => {
            if (!isBinary) return;

            const wispFrame = wispFrameParser(message);

            try {
                if (wispFrame.type === CONNECT_TYPE.CONNECT) {
                    const connectFrame = connectPacketParser(wispFrame.payload);

                    if (connectFrame.streamType === STREAM_TYPE.TCP) {
                        const client = new net.Socket();
                        const streamID = wispFrame.streamID;

                        client.on('connect', () => {
                            ws.send(continuePacketMaker(streamID, 127));
                        });

                        client.on('data', (data) => {
                            ws.send(dataPacketMaker(streamID, data));
                        });

                        client.on('error', () => {
                            if (ws.readyState === ws.OPEN) {
                                ws.send(closePacketMaker(streamID, 0x03));
                                ws.connections.delete(streamID);
                            }
                        });

                        client.on('close', () => {
                            if (ws.readyState === ws.OPEN) {
                                ws.send(closePacketMaker(streamID, 0x02));
                                ws.connections.delete(streamID);
                            }
                        });

                        client.connect(connectFrame.port, connectFrame.hostname);
                        ws.connections.set(streamID, { client, buffer: 127 });

                    } else if (connectFrame.streamType === STREAM_TYPE.UDP) {
                        let host = connectFrame.hostname;
                        let iplevel = net.isIP(host);

                        if (iplevel === 0) {
                            try {
                                const addresses = await dns.resolve(host);
                                host = addresses[0];
                                iplevel = net.isIP(host);
                            } catch (e) {
                                return;
                            }
                        }

                        if (iplevel !== 4 && iplevel !== 6) return;

                        const client = dgram.createSocket(iplevel === 6 ? "udp6" : "udp4");
                        const streamID = wispFrame.streamID;

                        client.on('message', (data) => {
                            ws.send(dataPacketMaker(streamID, data));
                        });

                        client.on('error', () => {
                            if (ws.readyState === ws.OPEN) {
                                ws.send(closePacketMaker(streamID, 0x03));
                                ws.connections.delete(streamID);
                            }
                            client.close();
                        });

                        client.on('close', () => {
                            if (ws.readyState === ws.OPEN) {
                                ws.send(closePacketMaker(streamID, 0x02));
                                ws.connections.delete(streamID);
                            }
                        });

                        client.connect(connectFrame.port, host, () => {
                            ws.send(continuePacketMaker(streamID, 127));
                        });
                        ws.connections.set(streamID, { client, buffer: 127 });
                    }
                } else if (wispFrame.type === CONNECT_TYPE.DATA) {
                    const stream = ws.connections.get(wispFrame.streamID);
                    if (stream && stream.client) {
                        if (stream.client instanceof net.Socket) {
                            stream.client.write(wispFrame.payload);
                        } else if (stream.client instanceof dgram.Socket) {
                            stream.client.send(wispFrame.payload);
                        }
                        stream.buffer--;
                        if (stream.buffer === 0) {
                            stream.buffer = 127;
                            ws.send(continuePacketMaker(wispFrame.streamID, stream.buffer));
                        }
                    }
                } else if (wispFrame.type === CONNECT_TYPE.CLOSE) {
                    const stream = ws.connections.get(wispFrame.streamID);
                    if (stream && stream.client) {
                        if (stream.client instanceof net.Socket) {
                            stream.client.destroy();
                        } else if (stream.client instanceof dgram.Socket) {
                            stream.client.close();
                        }
                    }
                    ws.connections.delete(wispFrame.streamID);
                }
            } catch (e) {
                console.error('Wisp error:', e);
            }
        });

        ws.on('close', () => {
            for (const { client } of ws.connections.values()) {
                if (client instanceof net.Socket) client.destroy();
                else if (client instanceof dgram.Socket) client.close();
            }
            ws.connections.clear();
        });
    });

    return {
        handleUpgrade(req, socket, head) {
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req);
            });
        }
    };
}
