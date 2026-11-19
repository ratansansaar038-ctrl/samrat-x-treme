import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { postViaStaticProxy, getViaStaticProxy } from "../src/main.js";

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

test("outgoing-IP diagnostic uses the proxy tunnel with GET and no merchant payload", async () => {
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalTlsConnect = tls.connect;
  const originalProxy = process.env.PROXY_URL;
  const proxySocket = new EventEmitter();
  proxySocket.destroy = () => {};
  const tlsSocket = new EventEmitter();
  tlsSocket.destroy = () => {};
  try {
    process.env.PROXY_URL = "http://test:secret@proxy.example:8080";
    http.request = (opts) => {
      assert.equal(opts.method, "CONNECT");
      assert.equal(opts.path, "api.ipify.org:443");
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => req.emit("connect", { statusCode: 200 }, proxySocket, Buffer.alloc(0)));
      return req;
    };
    tls.connect = (opts, callback) => {
      assert.equal(opts.socket, proxySocket);
      assert.equal(opts.servername, "api.ipify.org");
      assert.notEqual(opts.rejectUnauthorized, false);
      queueMicrotask(callback);
      return tlsSocket;
    };
    https.request = (opts, callback) => {
      assert.equal(opts.method, "GET");
      assert.equal(opts.hostname, "api.ipify.org");
      assert.equal(opts.path, "/?format=json");
      assert.equal(opts.headers["Content-Length"], undefined);
      assert.equal(opts.agent.createConnection(), tlsSocket);
      const req = new EventEmitter();
      req.write = () => assert.fail("Diagnostic GET must not contain a body");
      req.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        queueMicrotask(() => {
          callback(response);
          response.emit("data", Buffer.from('{"ip":"185.155.223.55"}'));
          response.emit("end");
          req.emit("close");
        });
      };
      return req;
    };
    const reply = await getViaStaticProxy("https://api.ipify.org?format=json");
    assert.equal(JSON.parse(reply.raw).ip, "185.155.223.55");
  } finally {
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    tls.connect = originalTlsConnect;
    if (originalProxy === undefined) delete process.env.PROXY_URL;
    else process.env.PROXY_URL = originalProxy;
  }
});
