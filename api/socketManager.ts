import {hLog} from '../helpers/common_functions';
import {Server, Socket} from 'socket.io';
import {createAdapter} from 'socket.io-redis';
import {io} from 'socket.io-client';
import {FastifyInstance} from "fastify";
import IORedis from "ioredis";
import {App, TemplatedApp} from 'uWebSockets.js';
import {streamPastActions, streamPastDeltas} from "./helpers/functions";

export interface StreamDeltasRequest {
    code: string;
    table: string;
    scope: string;
    payer: string;
    start_from: number | string;
    read_until: number | string;
}

export interface RequestFilter {
    field: string;
    value: string;
}

export interface StreamActionsRequest {
    contract: string;
    account: string;
    action: string;
    filters: RequestFilter[];
    start_from: number | string;
    read_until: number | string;
}


export class SocketManager {

    private io: Server;
    private relay;
    relay_restored = true;
    relay_down = false;
    private readonly url;
    private readonly server: FastifyInstance;
    private readonly uwsApp: TemplatedApp;

    constructor(fastify: FastifyInstance, url, redisOptions) {
        this.server = fastify;
        this.url = url;
        this.uwsApp = App({});

        // this.io = new Server(fastify.server, {
        // 	allowEIO3: true,
        // 	transports: ['websocket', 'polling'],
        // });

        // WS Server for public access
        this.io = new Server({
            transports: ['websocket'],
            path: '/stream'
        });

        this.io.attachApp(this.uwsApp);

        const pubClient = new IORedis(redisOptions);
        const subClient = pubClient.duplicate();
        this.io.adapter(createAdapter({pubClient, subClient}));

        this.io.on('connection', (socket: Socket) => {

            if (socket.handshake.headers['x-forwarded-for']) {
                hLog(`[socket] ${socket.id} connected via ${socket.handshake.headers['x-forwarded-for']}`);
            }

            socket.emit('message', {
                event: 'handshake',
                chain: fastify.manager.chain,
            });

            if (this.relay) {
                this.relay.emit('event', {
                    type: 'client_count',
                    counter: this.io.sockets.sockets.size,
                });
            }

            socket.on('delta_stream_request', async (data: StreamDeltasRequest, callback) => {
                if (typeof callback === 'function' && data) {
                    try {
                        if (data.start_from) {
                            await streamPastDeltas(this.server, socket, data);
                        }
                        this.emitToRelay(data, 'delta_request', socket, callback);
                    } catch (e) {
                        console.log(e);
                    }
                }
            });

            socket.on('action_stream_request', async (data: StreamActionsRequest, callback) => {
                if (typeof callback === 'function' && data) {
                    try {
                        if (data.start_from) {
                            await streamPastActions(this.server, socket, data);
                        }
                        this.emitToRelay(data, 'action_request', socket, callback);
                    } catch (e) {
                        console.log(e);
                    }
                }
            });

            socket.on('disconnect', (reason) => {
                hLog(`[socket] ${socket.id} disconnected - ${reason}`);
                this.relay.emit('event', {
                    type: 'client_disconnected',
                    id: socket.id,
                    reason,
                });
            });
        });

        try {
            this.uwsApp.listen(1234, () => {
                hLog('Socket.IO via uWS started!');
            });
        } catch (e) {
            hLog(e.message);
        }

        hLog('Websocket manager loaded!');
    }

    /*
    WS Relay will connect to the indexer
     */
    startRelay() {
        hLog(`starting relay - ${this.url}`);
        this.relay = io(this.url, {path: '/router'});

        this.relay.on('connect', () => {
            hLog('Relay Connected!');
            if (this.relay_down) {
                this.relay_restored = true;
                this.relay_down = false;
                this.io.emit('status', 'relay_restored');
            }
        });

        this.relay.on('disconnect', () => {
            hLog('Relay disconnected!');
            this.io.emit('status', 'relay_down');
            this.relay_down = true;
            this.relay_restored = false;
        });

        this.relay.on('delta', (traceData) => {
            this.emitToClient(traceData, 'delta_trace');
        });

        this.relay.on('trace', (traceData) => {
            this.emitToClient(traceData, 'action_trace');
        });

        // Relay LIB info to clients;
        this.relay.on('lib_update', (data) => {
            if (this.server.manager.conn.chains[this.server.manager.chain].chain_id === data.chain_id) {
                this.io.emit('lib_update', data);
            }
        });

        // Relay LIB info to clients;
        this.relay.on('fork_event', (data) => {
            hLog(data);
            if (this.server.manager.conn.chains[this.server.manager.chain].chain_id === data.chain_id) {
                this.io.emit('fork_event', data);
            }
        });
    }

    emitToClient(traceData, type) {
        if (this.io.sockets.sockets.has(traceData.client)) {
            this.io.sockets.sockets.get(traceData.client).emit('message', {
                type: type,
                mode: 'live',
                message: traceData.message,
            });
        }
    }

    emitToRelay(data, type, socket, callback) {
        if (this.relay.connected) {
            this.relay.emit('event', {
                type: type,
                client_socket: socket.id,
                request: data,
            }, (response) => {
                callback(response);
            });
        } else {
            callback('STREAMING_OFFLINE');
        }
    }
}
