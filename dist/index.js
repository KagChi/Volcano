"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const startTime = Date.now();
const http_1 = __importDefault(require("http"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const yaml_1 = __importDefault(require("yaml"));
const express_1 = __importDefault(require("express"));
const ws_1 = __importDefault(require("ws"));
const mixin_deep_1 = __importDefault(require("mixin-deep"));
const encoding = require("@lavalink/encoding");
const Constants_1 = __importDefault(require("./Constants"));
const Logger_1 = __importDefault(require("./util/Logger"));
const ThreadPool_1 = __importDefault(require("./util/ThreadPool"));
const Util_1 = __importDefault(require("./util/Util"));
const http_2 = __importDefault(require("./sources/http"));
const soundcloud_1 = __importDefault(require("./sources/soundcloud"));
const youtube_1 = __importDefault(require("./sources/youtube"));
const cpuCount = os_1.default.cpus().length;
const pool = new ThreadPool_1.default({
    size: cpuCount,
    dir: path_1.default.join(__dirname, "./worker.js")
});
const cfgyml = fs_1.default.readFileSync(path_1.default.join(process.cwd(), "./application.yml"), { encoding: "utf-8" });
const cfgparsed = yaml_1.default.parse(cfgyml);
const config = mixin_deep_1.default({}, Constants_1.default.defaultOptions, cfgparsed);
const rootLog = config.logging.level.root === "WARN" ? Logger_1.default.warn : config.logging.level.root === "ERROR" ? Logger_1.default.error : Logger_1.default.info;
const llLog = config.logging.level.lavalink === "WARN" ? Logger_1.default.warn : config.logging.level.lavalink === "ERROR" ? Logger_1.default.error : Logger_1.default.info;
if (config.spring.main["banner-mode"] === "log") {
    rootLog("\n" +
        "\x1b[33m__      __   _                                \x1b[97moOOOOo\n" +
        "\x1b[33m\\ \\    / /  | |                             \x1b[97mooOOoo  oo\n" +
        "\x1b[33m \\ \\  / /__ | | ___ __ _ _ __   ___        \x1b[0m/\x1b[31mvvv\x1b[0m\\    \x1b[97mo\n" +
        "\x1b[33m  \\ \\/ / _ \\| |/ __/ _` | '_ \\ / _ \\      \x1b[0m/\x1b[31mV V V\x1b[0m\\\n" +
        "\x1b[33m   \\  / (_) | | (_| (_| | | | | (_) |    \x1b[0m/   \x1b[31mV   \x1b[0m\\\n" +
        "\x1b[33m    \\/ \\___/|_|\\___\\__,_|_| |_|\\___/  \x1b[0m/\\/     \x1b[31mVV  \x1b[0m\\");
}
rootLog(`Starting on ${os_1.default.hostname()} with PID ${process.pid} (${__filename} started by ${os_1.default.userInfo().username} in ${process.cwd()})`);
rootLog(`Using ${cpuCount} worker threads in pool`);
const server = express_1.default();
const http = http_1.default.createServer(server);
const ws = new ws_1.default.Server({ noServer: true });
const connections = new Map();
const voiceServerStates = new Map();
const socketDeleteTimeouts = new Map();
const playerMap = new Map();
pool.on("message", (id, msg) => {
    const guildID = msg.data.guildId;
    const userID = msg.clientID;
    const socket = playerMap.get(`${userID}.${guildID}`);
    const entry = [...connections.values()].find(i => i.find(c => c.socket === socket));
    const rKey = entry === null || entry === void 0 ? void 0 : entry.find(c => c.socket);
    if (entry && rKey && rKey.resumeKey && socketDeleteTimeouts.has(rKey.resumeKey))
        socketDeleteTimeouts.get(rKey.resumeKey).events.push(msg.data);
    socket === null || socket === void 0 ? void 0 : socket.send(JSON.stringify(msg.data));
});
pool.on("datareq", (op, data) => {
    if (op === Constants_1.default.workerOPCodes.VOICE_SERVER) {
        const v = voiceServerStates.get(`${data.clientID}.${data.guildId}`);
        if (v)
            pool.broadcast({ op: Constants_1.default.workerOPCodes.VOICE_SERVER, data: v });
    }
});
async function getStats() {
    const memory = process.memoryUsage();
    const free = memory.heapTotal - memory.heapUsed;
    const pload = await Util_1.default.processLoad();
    const osload = os_1.default.loadavg();
    const threadStats = await pool.broadcast({ op: Constants_1.default.workerOPCodes.STATS });
    return {
        players: threadStats.reduce((acc, cur) => acc + cur.players, 0),
        playingPlayers: threadStats.reduce((acc, cur) => acc + cur.playingPlayers, 0),
        uptime: process.uptime(),
        memory: {
            reservable: memory.heapTotal - free,
            used: memory.heapUsed,
            free: free,
            allocated: memory.rss
        },
        cpu: {
            cores: cpuCount,
            systemLoad: osload[0],
            lavalinkLoad: pload
        },
        frameStats: {
            sent: 0,
            nulled: 0,
            deficit: 0
        }
    };
}
function socketHeartbeat() {
    this.isAlive = true;
}
function noop() { void 0; }
ws.on("headers", (headers, request) => {
    headers.push(`Session-Resumed: ${!!request.headers["resume-key"] && socketDeleteTimeouts.has(request.headers["resume-key"])}`, "Lavalink-Major-Version: 3");
});
http.on("upgrade", (request, socket, head) => {
    llLog(`Incoming connection from /${request.socket.remoteAddress}:${request.socket.remotePort}`);
    const temp401 = "HTTP/1.1 401 Unauthorized\r\n\r\n";
    const passwordIncorrect = (config.lavalink.server.password !== undefined && request.headers.authorization !== String(config.lavalink.server.password));
    const invalidUserID = (!request.headers["user-id"] || Array.isArray(request.headers["user-id"]) || !request.headers["user-id"].match(/^\d+$/));
    if (passwordIncorrect || invalidUserID)
        return socket.write(temp401, () => socket.destroy());
    const userID = request.headers["user-id"];
    ws.handleUpgrade(request, socket, head, s => {
        if (request.headers["resume-key"] && socketDeleteTimeouts.has(request.headers["resume-key"])) {
            const resume = socketDeleteTimeouts.get(request.headers["resume-key"]);
            clearTimeout(resume.timeout);
            socketDeleteTimeouts.delete(request.headers["resume-key"]);
            const exist = connections.get(userID);
            if (exist) {
                const pre = exist.find(i => i.resumeKey === request.headers["resume-key"]);
                if (pre)
                    pre.socket = s;
                else
                    exist.push({ socket: s, resumeKey: null, resumeTimeout: 60 });
            }
            else
                connections.set(userID, [{ socket: s, resumeKey: null, resumeTimeout: 60 }]);
            llLog(`Replaying ${resume.events.length}`);
            for (const event of resume.events) {
                s.send(JSON.stringify(event));
            }
            resume.events.length = 0;
            llLog(`Resumed session with key ${request.headers["resume-key"]}`);
            return ws.emit("connection", s, request);
        }
        llLog("Connection successfully established");
        const existing = connections.get(userID);
        const pl = { socket: s, resumeKey: null, resumeTimeout: 60 };
        if (existing)
            existing.push(pl);
        else
            connections.set(userID, [pl]);
        ws.emit("connection", s, request);
    });
});
ws.on("connection", async (socket, request) => {
    const userID = request.headers["user-id"];
    const stats = await getStats();
    socket.send(JSON.stringify(Object.assign(stats, { op: "stats" })));
    socket.on("message", data => onClientMessage(socket, data, userID));
    socket.isAlive = true;
    socket.on("pong", socketHeartbeat);
    socket.once("close", code => onClientClose(socket, userID, code));
    socket.once("error", () => onClientClose(socket, userID, 1000));
});
async function onClientMessage(socket, data, userID) {
    let buf;
    if (Array.isArray(data))
        buf = Buffer.concat(data);
    else if (data instanceof ArrayBuffer)
        buf = Buffer.from(data);
    else
        buf = data;
    const d = buf.toString();
    const msg = JSON.parse(d);
    llLog(msg);
    const pl = { op: Constants_1.default.workerOPCodes.MESSAGE, data: Object.assign(msg, { clientID: userID }) };
    if (msg.op === "play") {
        if (!msg.guildId || !msg.track)
            return;
        const responses = await pool.broadcast(pl);
        if (!responses.includes(true))
            pool.execute(pl);
        return playerMap.set(`${userID}.${msg.guildId}`, socket);
    }
    else if (msg.op === "voiceUpdate") {
        voiceServerStates.set(`${userID}.${msg.guildId}`, { clientID: userID, guildId: msg.guildId, sessionId: msg.sessionId, event: msg.event });
        setTimeout(() => voiceServerStates.delete(`${userID}.${msg.guildId}`), 20000);
        return pool.broadcast({ op: Constants_1.default.workerOPCodes.VOICE_SERVER, data: voiceServerStates.get(`${userID}.${msg.guildId}`) });
    }
    else if (msg.op === "stop" || msg.op === "pause" || msg.op === "destroy" || msg.op === "filters") {
        if (!msg.guildId)
            return;
        return pool.broadcast(pl);
    }
    else if (msg.op === "configureResuming") {
        if (!msg.key)
            return;
        const entry = connections.get(userID);
        const found = entry.find(i => i.socket === socket);
        if (found) {
            found.resumeKey = msg.key;
            found.resumeTimeout = msg.timeout || 60;
        }
    }
}
function onClientClose(socket, userID, closeCode) {
    if (socket.readyState !== ws_1.default.CLOSING && socket.readyState !== ws_1.default.CLOSED)
        socket.close(closeCode);
    socket.removeAllListeners();
    const entry = connections.get(userID);
    const found = entry.find(i => i.socket === socket);
    if (found) {
        if (found.resumeKey) {
            const remote = socket._socket ? socket._socket.address() : { port: undefined, address: socket.url };
            llLog(`Connection closed from /${remote.address}${remote.port ? `:${remote.port}` : ""} with status CloseStatus[code=${closeCode}, reason=destroy] -- Session can be resumed within the next ${found.resumeTimeout} seconds with key ${found.resumeKey}`);
            socketDeleteTimeouts.set(found.resumeKey, { timeout: setTimeout(() => {
                    const index = entry.indexOf(found);
                    if (index === -1)
                        return;
                    entry.splice(index, 1);
                    socketDeleteTimeouts.delete(found.resumeKey);
                    if (entry.length === 0)
                        connections.delete(userID);
                    pool.broadcast({ op: Constants_1.default.workerOPCodes.DELETE_ALL, data: { clientID: userID } });
                }, (found.resumeTimeout || 60) * 1000), events: [] });
        }
        else {
            const index = entry.indexOf(found);
            if (index === -1)
                return;
            entry.splice(index, 1);
            if (entry.length === 0)
                connections.delete(userID);
        }
    }
    for (const key of voiceServerStates.keys()) {
        if (key.startsWith(userID))
            voiceServerStates.delete(key);
    }
}
const serverLoopInterval = setInterval(async () => {
    const stats = await getStats();
    const payload = Object.assign(stats, { op: "stats" });
    const str = JSON.stringify(payload);
    for (const client of ws.clients) {
        if (client.isAlive === false)
            return client.terminate();
        client.isAlive = false;
        if (client.readyState === ws_1.default.OPEN) {
            client.ping(noop);
            client.send(str);
        }
    }
}, 1000 * 60);
const IDRegex = /(ytsearch:)?(scsearch:)?(.+)/;
server.use((req, res, next) => {
    if (config.lavalink.server.password && (!req.headers.authorization || req.headers.authorization !== String(config.lavalink.server.password)))
        return res.status(401).send("Unauthorized");
    next();
});
const soundCloudURL = new URL(Constants_1.default.baseSoundcloudURL);
server.get("/loadtracks", async (request, response) => {
    const identifier = request.query.identifier;
    const payload = {
        playlistInfo: {},
        tracks: []
    };
    let playlist = false;
    if (!identifier || typeof identifier !== "string")
        return Util_1.default.standardErrorHandler("Invalid or no identifier query string provided.", response, payload, llLog);
    llLog(`Got request to load for identifier "${identifier}"`);
    const match = identifier.match(IDRegex);
    if (!match)
        return Util_1.default.standardErrorHandler("Identifier did not match regex", response, payload, llLog);
    const isYouTubeSearch = !!match[1];
    const isSoundcloudSearch = !!match[2];
    const resource = match[3];
    if (!resource)
        return Util_1.default.standardErrorHandler("Invalid or no identifier query string provided.", response, payload, llLog);
    let url;
    if (resource.startsWith("http"))
        url = new URL(resource);
    if (isSoundcloudSearch || (url && url.hostname === soundCloudURL.hostname)) {
        if (isSoundcloudSearch && !config.lavalink.server.soundcloudSearchEnabled)
            return response.status(200).send(JSON.stringify(Object.assign(payload, { loadType: "LOAD_FAILED", exception: { message: "Soundcloud searching is not enabled.", severity: "COMMON" } })));
        const data = await soundcloud_1.default(resource, isSoundcloudSearch).catch(e => Util_1.default.standardErrorHandler(e, response, payload, llLog));
        if (!data)
            return;
        const tracks = data.map(info => { return { track: encoding.encode(Object.assign({ flags: 1, version: 2, source: "soundcloud" }, info, { position: BigInt(info.position), length: BigInt(Math.round(info.length)) })), info: info }; });
        payload.tracks = tracks;
        if (tracks.length === 0)
            return Util_1.default.standardErrorHandler("Could not extract Soundcloud info.", response, payload, llLog, "NO_MATCHES");
        else if (tracks.length === 1)
            llLog(`Loaded track ${tracks[0].info.title}`);
    }
    else if (url && !url.hostname.includes("youtu")) {
        if (!config.lavalink.server.sources.http)
            return Util_1.default.standardErrorHandler("HTTP is not enabled.", response, payload, llLog);
        const data = await http_2.default(resource).catch(e => Util_1.default.standardErrorHandler(e, response, payload, llLog));
        if (!data)
            return;
        const info = {
            identifier: resource,
            author: data.extra.author || data.parsed.common.artist || "Unknown artist",
            length: Math.round((data.parsed.format.duration || 0) * 1000),
            isStream: data.extra.stream,
            position: 0,
            title: data.extra.title || data.parsed.common.title || "Unknown title",
            uri: resource,
        };
        llLog(`Loaded track ${info.title}`);
        const encoded = encoding.encode(Object.assign({ flags: 1, version: 2, source: "http", probeInfo: { raw: data.extra.probe, name: data.extra.probe, parameters: null } }, info, { position: BigInt(info.position), length: BigInt(Math.round(info.length)) }));
        const track = { track: encoded, info: Object.assign({ isSeekable: !info.isStream }, info) };
        payload.tracks.push(track);
    }
    else {
        if (isYouTubeSearch && !config.lavalink.server.youtubeSearchEnabled)
            return response.status(200).send(JSON.stringify(Object.assign(payload, { loadType: "LOAD_FAILED", exception: { message: "YouTube searching is not enabled.", severity: "COMMON" } })));
        const data = await youtube_1.default(resource, isYouTubeSearch).catch(e => Util_1.default.standardErrorHandler(e, response, payload, llLog));
        if (!data)
            return;
        const infos = data.entries.map(i => { return { identifier: i.id, author: i.uploader, length: Math.round(i.duration * 1000), isStream: i.duration === 0, isSeekable: i.duration !== 0, position: 0, title: i.title, uri: `https://youtube.com/watch?v=${i.id}` }; });
        const tracks = infos.map(info => { return { track: encoding.encode(Object.assign({ flags: 1, version: 2, source: "youtube" }, info, { position: BigInt(info.position), length: BigInt(Math.round(info.length)) })), info: info }; });
        if (data.plData) {
            payload.playlistInfo = data.plData;
            playlist = true;
            llLog(`Loaded playlist ${data.plData.name}`);
        }
        payload.tracks = tracks;
        if (tracks.length === 0)
            return Util_1.default.standardErrorHandler("Could not extract Soundcloud info.", response, payload, llLog, "NO_MATCHES");
        else if (tracks.length === 1 && !data.plData)
            llLog(`Loaded track ${tracks[0].info.title}`);
    }
    if (payload.tracks.length === 0)
        return Util_1.default.standardErrorHandler("No matches.", response, payload, llLog, "NO_MATCHES");
    return response.status(200).send(JSON.stringify(Object.assign({ loadType: payload.tracks.length > 1 && (isYouTubeSearch || isSoundcloudSearch) ? "SEARCH_RESULT" : playlist ? "PLAYLIST_LOADED" : "TRACK_LOADED" }, payload)));
});
server.get("/decodetracks", (request, response) => {
    const track = request.query.track;
    if (!track || !(typeof track === "string" || (Array.isArray(track) && track.every(i => typeof i === "string"))))
        return Util_1.default.standardErrorHandler("Invalid or no track query string provided.", response, {}, llLog);
    let data = undefined;
    if (Array.isArray(track))
        data = track.map(i => { return { track: i, info: convertDecodedTrackToResponse(encoding.decode(i)) }; });
    else
        data = convertDecodedTrackToResponse(encoding.decode(track));
    return response.status(200).send(JSON.stringify(data));
});
function convertDecodedTrackToResponse(data) {
    return {
        identifier: data.identifier,
        isSeekable: !data.isStream,
        author: data.author,
        length: data.length,
        isStream: data.isStream,
        position: data.position,
        title: data.title,
        uri: data.uri,
        sourceName: data.source
    };
}
http.listen(config.server.port, config.server.address, () => {
    rootLog(`HTTP and Socket started on port ${config.server.port} binding to ${config.server.address}`);
    rootLog(`Started in ${(Date.now() - startTime) / 1000} seconds (Node running for ${process.uptime()})`);
});
ws.once("close", () => {
    clearInterval(serverLoopInterval);
    rootLog("Socket server has closed.");
    for (const child of pool.children.values()) {
        child.terminate();
    }
});
process.on("unhandledRejection", (reason) => Logger_1.default.error(reason));
process.title = "Volcano";