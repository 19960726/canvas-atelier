import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererRoot = path.join(projectRoot, 'apps', 'renderer');
const rendererViteEntry = path.join(rendererRoot, 'node_modules', 'vite', 'dist', 'node', 'index.js');
const port = Number(process.env.NOVUS_E2E_PORT ?? 43127);
const e2eNonce = process.env.NOVUS_E2E_NONCE ?? '';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('NOVUS_E2E_PORT must be a valid TCP port');
}
if (!e2eNonce) {
  throw new Error('NOVUS_E2E_NONCE is required');
}

const { createServer } = await import(pathToFileURL(rendererViteEntry).href);
let server;
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server?.close();
};

server = await createServer({
  root: rendererRoot,
  configLoader: 'runner',
  plugins: [{
    name: 'novus-e2e-shutdown',
    configureServer(viteServer) {
      viteServer.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `127.0.0.1:${port}`}`);
        if (url.pathname !== '/__novus_e2e_shutdown') {
          next();
          return;
        }
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end();
          return;
        }
        if (request.headers['x-novus-e2e-nonce'] !== e2eNonce) {
          response.statusCode = 403;
          response.end();
          return;
        }
        response.statusCode = 204;
        response.end();
        setImmediate(() => { void close().finally(() => process.exit(0)); });
      });
    },
  }],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
  },
});

await server.listen();
server.printUrls();

process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
process.once('SIGHUP', () => { void close().finally(() => process.exit(0)); });