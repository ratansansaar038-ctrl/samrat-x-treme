import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { postViaStaticProxy } from "../src/main.js";

test("gateway traffic stays on the verified proxy TLS tunnel", async () => {
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalTlsConnect = tls.connect;
  const originalProxy = process.env.PROXY_URL;
  const tlsSocket = new EventEmitter();
  tlsSocket.destroy = () => {};
  const proxySocket = new EventEmitter();
  proxySocket.destroy = () => {};
  const tunnel = { statusCode: 200 };

  try {
    process.env.PROXY_URL = "http://merchant:pass@proxy.example:8080";
    http.request = (opts) => {
      assert.equal(opts.method, "CONNECT");
      assert.equal(opts.host, "proxy.example");
      assert.equal(opts.path, "gateway.example:443");
      assert.match(opts.headers["Proxy-Authorization"], /^Basic /);
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => req.emit("connect", tunnel, proxySocket, Buffer.alloc(0)));
      return req;
    };
    tls.connect = (opts, onConnected) => {
      assert.equal(opts.socket, proxySocket);
      assert.equal(opts.servername, "gateway.example");
      assert.notEqual(opts.rejectUnauthorized, false);
      queueMicrotask(onConnected);
      return tlsSocket;
    };
    https.request = (opts, onResponse) => {
      assert.equal(opts.hostname, "gateway.example");
      assert.equal(opts.agent.createConnection(), tlsSocket);
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        queueMicrotask(() => {
          onResponse(res);
          res.emit("data", Buffer.from('{"ok":true}'));
          res.emit("end");
          req.emit("close");
        });
      };
      return req;
    };

    const reply = await postViaStaticProxy("https://gateway.example/create", "{}", {});
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(JSON.parse(reply.raw), { ok: true });
  } finally {
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    tls.connect = originalTlsConnect;
    if (originalProxy === undefined) delete process.env.PROXY_URL;
    else process.env.PROXY_URL = originalProxy;
  }
});

test("payment API calls fail closed if no static-IP proxy is configured", async () => {
  const originalProxy = process.env.PROXY_URL;
  try {
    delete process.env.PROXY_URL;
    await assert.rejects(() => postViaStaticProxy("https://gateway.example/create", "{}", {}),
      /PROXY_URL is required/);
  } finally {
    if (originalProxy !== undefined) process.env.PROXY_URL = originalProxy;
  }
});
