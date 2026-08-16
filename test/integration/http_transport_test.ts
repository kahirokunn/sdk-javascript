/*
 Copyright 2021 The CloudEvents Authors
 SPDX-License-Identifier: Apache-2.0
*/

import "mocha";
import { rejects } from "assert";
import { expect } from "chai";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";

import {
  HTTPTransportError, Mode, emitterFor, httpTransport,
} from "../../src";
import { assertStructured, fixture } from "./emitter_factory_test";

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

describe("Built-in HTTP transport", () => {
  it("Sends a binary event and resolves with void for 2xx", async () => {
    let receivedBody: Record<string, string> | undefined;
    let receivedHeaders: IncomingMessage["headers"] | undefined;

    await withServer(async (request, response) => {
      receivedHeaders = request.headers;
      receivedBody = JSON.parse((await requestBody(request)).toString());
      response.writeHead(202);
      response.end("accepted response body is not returned");
    }, async (url) => {
      const emit = emitterFor(httpTransport(`${url}/events`));
      const result: void = await emit(fixture, { headers: { "ce-type": "transport.test" } });

      expect(result).to.equal(undefined);
      expect(receivedHeaders?.["ce-type"]).to.equal("transport.test");
      expect(receivedHeaders?.["ce-source"]).to.equal(fixture.source);
      expect(receivedBody?.lunchBreak).to.equal("noon");
    });
  });

  it("Sends a structured event", async () => {
    let received: Record<string, Record<string, string>> | undefined;

    await withServer(async (request, response) => {
      received = {
        ...JSON.parse((await requestBody(request)).toString()),
        ...request.headers,
      };
      response.writeHead(204);
      response.end();
    }, async (url) => {
      const emit = emitterFor(httpTransport(url), { mode: Mode.STRUCTURED });
      await emit(fixture);
      assertStructured(received as Record<string, Record<string, string>>);
    });
  });

  for (const statusCode of [400, 503]) {
    it(`Reports a ${statusCode} response without retrying it`, async () => {
      let requestCount = 0;

      await withServer((_request, response) => {
        requestCount++;
        response.writeHead(statusCode, { "x-request-id": `request-${statusCode}` });
        response.end(`status ${statusCode}`);
      }, async (url) => {
        const emit = emitterFor(httpTransport(url));
        await rejects(emit(fixture), (error: HTTPTransportError) => {
          expect(error).to.be.instanceOf(HTTPTransportError);
          expect(error.kind).to.equal("http-status");
          expect(error.statusCode).to.equal(statusCode);
          expect(error.headers?.["x-request-id"]).to.equal(`request-${statusCode}`);
          expect(error.responseBody).to.equal(`status ${statusCode}`);
          expect(error.responseBodyTruncated).to.equal(false);
          expect(error.cause).to.equal(undefined);
          return true;
        });
        expect(requestCount).to.equal(1);
      });
    });
  }

  for (const statusCode of [301, 302, 303]) {
    it(`Returns ${statusCode} as an error by default instead of following it`, async () => {
      let requestCount = 0;
      let targetRequestCount = 0;

      await withServer((request, response) => {
        requestCount++;
        if (request.url === "/target") {
          targetRequestCount++;
          response.writeHead(204);
        } else {
          response.writeHead(statusCode, { location: "/target" });
        }
        response.end();
      }, async (url) => {
        const emit = emitterFor(httpTransport(`${url}/start`));
        await rejects(emit(fixture), (error: HTTPTransportError) => {
          expect(error.kind).to.equal("http-status");
          expect(error.statusCode).to.equal(statusCode);
          return true;
        });
        expect(requestCount).to.equal(1);
        expect(targetRequestCount).to.equal(0);
      });
    });
  }

  for (const statusCode of [307, 308]) {
    it(`Preserves the POST method and body while following ${statusCode}`, async () => {
      let originalBody = "";
      let redirectedBody = "";
      let redirectedMethod: string | undefined;

      await withServer(async (request, response) => {
        if (request.url === "/target") {
          redirectedMethod = request.method;
          redirectedBody = (await requestBody(request)).toString();
          response.writeHead(202);
        } else {
          originalBody = (await requestBody(request)).toString();
          response.writeHead(statusCode, { location: "/target" });
        }
        response.end();
      }, async (url) => {
        const emit = emitterFor(httpTransport(`${url}/start`, { redirect: "follow" }));
        await emit(fixture);
        expect(redirectedMethod).to.equal("POST");
        expect(redirectedBody).to.equal(originalBody);
      });
    });
  }

  it("Uses Fetch semantics when following a 302 redirect", async () => {
    let redirectedBody = "not received";
    let redirectedMethod: string | undefined;

    await withServer(async (request, response) => {
      if (request.url === "/target") {
        redirectedMethod = request.method;
        redirectedBody = (await requestBody(request)).toString();
        response.writeHead(204);
      } else {
        await requestBody(request);
        response.writeHead(302, { location: "/target" });
      }
      response.end();
    }, async (url) => {
      const emit = emitterFor(httpTransport(`${url}/start`, { redirect: "follow" }));
      await emit(fixture);
      expect(redirectedMethod).to.equal("GET");
      expect(redirectedBody).to.equal("");
    });
  });

  it("Limits an error response body to 64 KiB by default", async () => {
    await withServer((_request, response) => {
      response.writeHead(500);
      response.end(`${"a".repeat(65_536)}not retained`);
    }, async (url) => {
      const emit = emitterFor(httpTransport(url));
      await rejects(emit(fixture), (error: HTTPTransportError) => {
        expect(error.responseBody).to.equal("a".repeat(65_536));
        expect(error.responseBodyTruncated).to.equal(true);
        return true;
      });
    });
  });

  it("Supports a custom error response body limit", async () => {
    await withServer((_request, response) => {
      response.writeHead(500);
      response.end("response body");
    }, async (url) => {
      const emit = emitterFor(httpTransport(url, { maxErrorBodyBytes: 4 }));
      await rejects(emit(fixture), (error: HTTPTransportError) => {
        expect(error.responseBody).to.equal("resp");
        expect(error.responseBodyTruncated).to.equal(true);
        return true;
      });
    });
  });

  it("Supports omitting an error response body", async () => {
    await withServer((_request, response) => {
      response.writeHead(500);
      response.end("response body");
    }, async (url) => {
      const emit = emitterFor(httpTransport(url, { maxErrorBodyBytes: 0 }));
      await rejects(emit(fixture), (error: HTTPTransportError) => {
        expect(error.responseBody).to.equal("");
        expect(error.responseBodyTruncated).to.equal(true);
        return true;
      });
    });
  });

  it("Reports a timeout while waiting for response headers", async () => {
    await withServer(() => undefined, async (url) => {
      const emit = emitterFor(httpTransport(url, { timeoutMs: 50 }));
      await rejects(emit(fixture), (error: HTTPTransportError) => {
        expect(error.kind).to.equal("timeout");
        expect(error.statusCode).to.equal(undefined);
        expect(error.timeoutMs).to.equal(50);
        expect(error.cause).not.to.equal(undefined);
        return true;
      });
    });
  });

  it("Preserves a known status when reading its error body fails", async () => {
    await withServer((_request, response) => {
      response.writeHead(503);
      response.write("partial");
    }, async (url) => {
      const emit = emitterFor(httpTransport(url, { timeoutMs: 50 }));
      await rejects(emit(fixture), (error: HTTPTransportError) => {
        expect(error.kind).to.equal("http-status");
        expect(error.statusCode).to.equal(503);
        expect(error.responseBody).to.equal("partial");
        expect(error.responseBodyTruncated).to.equal(true);
        expect(error.timeoutMs).to.equal(50);
        expect(error.cause).not.to.equal(undefined);
        return true;
      });
    });
  });

  it("Reports a network failure with its cause", async () => {
    const unavailableUrl = await closedServerUrl();
    const emit = emitterFor(httpTransport(unavailableUrl));

    await rejects(emit(fixture), (error: HTTPTransportError) => {
      expect(error.kind).to.equal("network");
      expect(error.statusCode).to.equal(undefined);
      expect(error.timeoutMs).to.equal(undefined);
      expect(error.cause).not.to.equal(undefined);
      return true;
    });
  });

  it("Validates the sink and transport options when the transport is created", () => {
    expect(() => httpTransport("not a URL")).to.throw(TypeError);
    expect(() => httpTransport("ftp://events.example.com")).to.throw(TypeError, "unsupported protocol ftp:");
    for (const timeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => httpTransport("https://events.example.com", { timeoutMs }))
        .to.throw(RangeError, "timeoutMs must be a positive safe integer");
    }
    for (const maxErrorBodyBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => httpTransport("https://events.example.com", { maxErrorBodyBytes }))
        .to.throw(RangeError, "maxErrorBodyBytes must be a non-negative safe integer");
    }
    expect(() => httpTransport("https://events.example.com", { redirect: "invalid" as "manual" }))
      .to.throw(TypeError, "redirect must be either \"manual\" or \"follow\"");
  });
});

async function withServer(handler: Handler, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function closedServerUrl(): Promise<string> {
  let url = "";
  await withServer(() => undefined, async (serverUrl) => {
    url = serverUrl;
  });
  return url;
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
