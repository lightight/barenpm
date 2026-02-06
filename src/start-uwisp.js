import { uwsServer } from '../uWisp-server/src/index.mjs';

const port = 1104;

uwsServer.listen(port, (token) => {
    if (token) {
        console.log(`uWisp (uWebSockets.js) server listening on port ${port}`);
    } else {
        console.error(`uWisp (uWebSockets.js) server failed to listen on port ${port}`);
    }
});
