import { loadSecrets } from "./secrets.ts";

const HEALTH_PORT = 9999;

const secrets = loadSecrets();

const server = Bun.serve({
  port: HEALTH_PORT,
  fetch() {
    return new Response("ok", { status: 200 });
  },
});

console.log(`[nanoclaw] NanoClaw daemon running (health: http://localhost:${server.port})`);
console.log(`[nanoclaw] secrets: ${secrets.size}, pid: ${process.pid}`);
