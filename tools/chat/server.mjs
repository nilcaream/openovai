// The instance's chat server: one page, one conversation, one leader session.
//
// It listens on 127.0.0.1 only. A workspace is one person's machine, and a chat that can
// drive a Claude Code session is not something to put on a network by accident.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { append, read } from "./conversation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "page.html");
const HOST = "127.0.0.1";

// Enough for anything a person types, small enough that a runaway client cannot fill memory.
const LONGEST_MESSAGE = 100_000;

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

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > LONGEST_MESSAGE) {
        reject(new Error("that message is too long"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function postMessage(instance, request, response) {
  let text;
  try {
    ({ text } = JSON.parse(await readBody(request)));
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  if (typeof text !== "string" || text.trim() === "") {
    sendJson(response, 400, { error: "a message needs some text" });
    return;
  }

  sendJson(response, 200, { message: append(instance.root, { from: "human", text: text.trim() }) });
}

async function handle(instance, request, response) {
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

  if (request.method === "GET" && url.pathname === "/messages") {
    sendJson(response, 200, { messages: read(instance.root) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/message") {
    await postMessage(instance, request, response);
    return;
  }

  sendJson(response, 404, { error: `nothing at ${request.method} ${url.pathname}` });
}

export function serve(instance) {
  const server = http.createServer((request, response) => {
    handle(instance, request, response).catch((error) => {
      sendJson(response, 500, { error: error.message });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(instance.config.port, HOST, () => resolve(server));
  });
}
