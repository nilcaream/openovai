// The instance's chat server: one page, one conversation, one leader session.
//
// It listens on 127.0.0.1 only. A workspace is one person's machine, and a chat that can
// drive a Claude Code session is not something to put on a network by accident.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "page.html");
const HOST = "127.0.0.1";

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function sendPage(response) {
  const page = fs.readFileSync(PAGE);
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": page.length,
  });
  response.end(page);
}

function handle(instance, request, response) {
  const url = new URL(request.url, `http://${HOST}`);

  if (request.method === "GET" && url.pathname === "/") {
    sendPage(response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      instance: instance.root,
      human: instance.config.human,
      leader: instance.config.leader,
      model: instance.config.models.leader,
    });
    return;
  }

  sendJson(response, 404, { error: `nothing at ${request.method} ${url.pathname}` });
}

export function serve(instance) {
  const server = http.createServer((request, response) => {
    try {
      handle(instance, request, response);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(instance.config.port, HOST, () => resolve(server));
  });
}
