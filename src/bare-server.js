import { createBareServer } from "@tomphttp/bare-server-node";
import { createServer } from "node:http";
import { createWispServer } from "./wisp.js";

const wisp = createWispServer();

const bare = createBareServer("/bare/", {
    logErrors: false,
    localAddress: undefined,
    maintainer: undefined,
    connectionLimiter: {
        maxConnectionsPerIP: 10000
    }
});

const server = createServer();

server.on("request", (req, res) => {
    // Enable CORS for all origins
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bare-Host, X-Bare-Path, X-Bare-Port, X-Bare-Headers, X-Bare-Forward-Headers, X-Bare-URL, X-Bare-Protocol");

    if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
    }

    if (bare.shouldRoute(req)) {
        bare.routeRequest(req, res);
    } else {
        res.writeHead(400);
        res.end("Not found.");
    }
});

server.on("upgrade", (req, socket, head) => {
    if (req.url.endsWith("/wisp/")) {
        wisp.handleUpgrade(req, socket, head);
    } else if (bare.shouldRoute(req)) {
        bare.routeUpgrade(req, socket, head);
    } else {
        socket.end();
    }
});

server.on("connection", (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
});

server.on("listening", () => {
    console.log("Bare server listening on http://localhost:1103");
});

server.listen(1103);
