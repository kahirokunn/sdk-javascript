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

  it("Applies transport headers and lets per-send headers override them", async () => {
    const receivedHeaders: IncomingMessage["headers"][] = [];

    await withServer((request, response) => {
      receivedHeaders.push(request.headers);
      response.writeHead(204);
      response.end();
    }, async (url) => {
      const emit = emitterFor(httpTransport(url, {
        headers: new Headers({
          authorization: "Bearer transport-token",
          "ce-type": "transport.test",
          "x-tenant-id": "store-42",
        }),
      }));

      await emit(fixture);
      await emit(fixture, {
        headers: { "ce-type": "send.test", "x-request-id": "order-123" },
      });

      expect(receivedHeaders[0]?.authorization).to.equal("Bearer transport-token");
      expect(receivedHeaders[0]?.["x-tenant-id"]).to.equal("store-42");
      expect(receivedHeaders[0]?.["ce-type"]).to.equal("transport.test");
      expect(receivedHeaders[1]?.authorization).to.equal("Bearer transport-token");
      expect(receivedHeaders[1]?.["ce-type"]).to.equal("send.test");
      expect(receivedHeaders[1]?.["x-request-id"]).to.equal("order-123");
    });
  });

  it("Passes standard Fetch options to fetch", async () => {
    const originalFetch = globalThis.fetch;
    let receivedOptions: RequestInit | undefined;
    globalThis.fetch = async (_input, options) => {
      receivedOptions = options;
      return new Response(null, { status: 204 });
    };

    try {
      const emit = emitterFor(httpTransport("https://events.example.com/orders", {
        fetchOptions: {
          cache: "no-store",
          credentials: "include",
          redirect: "error",
        },
      }));
      await emit(fixture);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(receivedOptions?.cache).to.equal("no-store");
    expect(receivedOptions?.credentials).to.equal("include");
    expect(receivedOptions?.redirect).to.equal("error");
    expect(receivedOptions?.method).to.equal("POST");
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
        await expectTransportError(emit(fixture), (error) => {
          expect(error.kind).to.equal("http-status");
          expect(error.statusCode).to.equal(statusCode);
          expect(error.headers?.["x-request-id"]).to.equal(`request-${statusCode}`);
          expect(error.responseBody).to.equal(`status ${statusCode}`);
          expect(error.responseBodyTruncated).to.equal(false);
          expect(error.cause).to.equal(undefined);
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
        await expectTransportError(emit(fixture), (error) => {
          expect(error.kind).to.equal("http-status");
          expect(error.statusCode).to.equal(statusCode);
        });
        expect(requestCount).to.equal(1);
        expect(targetRequestCount).to.equal(0);
      });
    });
  }

  // Fetch keeps POST only for 307 and 308; the others may be rewritten to a bodyless GET.
  for (const { statusCode, method, keepsBody } of [
    { statusCode: 301, method: "GET", keepsBody: false },
    { statusCode: 302, method: "GET", keepsBody: false },
    { statusCode: 303, method: "GET", keepsBody: false },
    { statusCode: 307, method: "POST", keepsBody: true },
    { statusCode: 308, method: "POST", keepsBody: true },
  ]) {
    it(`Follows ${statusCode} with Fetch semantics when redirect is "follow"`, async () => {
      let originalBody = "";
      let redirectedBody = "not received";
      let redirectedMethod: string | undefined;

      await withServer(async (request, response) => {
        if (request.url === "/target") {
          redirectedMethod = request.method;
          redirectedBody = (await requestBody(request)).toString();
          response.writeHead(204);
        } else {
          originalBody = (await requestBody(request)).toString();
          response.writeHead(statusCode, { location: "/target" });
        }
        response.end();
      }, async (url) => {
        const emit = emitterFor(httpTransport(`${url}/start`, {
          fetchOptions: { redirect: "follow" },
        }));
        await emit(fixture);
        expect(redirectedMethod).to.equal(method);
        expect(redirectedBody).to.equal(keepsBody ? originalBody : "");
      });
    });
  }

  for (const { title, options, sent, retained } of [
    {
      title: "Limits an error response body to 64 KiB by default",
      options: {}, sent: `${"a".repeat(65_536)}not retained`, retained: "a".repeat(65_536),
    },
    {
      title: "Supports a custom error response body limit",
      options: { maxErrorBodyBytes: 4 }, sent: "response body", retained: "resp",
    },
    {
      title: "Supports omitting an error response body",
      options: { maxErrorBodyBytes: 0 }, sent: "response body", retained: "",
    },
  ]) {
    it(title, async () => {
      await withServer((_request, response) => {
        response.writeHead(500);
        response.end(sent);
      }, async (url) => {
        const emit = emitterFor(httpTransport(url, options));
        await expectTransportError(emit(fixture), (error) => {
          expect(error.responseBody).to.equal(retained);
          expect(error.responseBodyTruncated).to.equal(true);
        });
      });
    });
  }

  it("Reports a timeout while waiting for response headers", async () => {
    await withServer(() => undefined, async (url) => {
      const emit = emitterFor(httpTransport(url, { timeoutMs: 50 }));
      await expectTransportError(emit(fixture), (error) => {
        expect(error.kind).to.equal("timeout");
        expect(error.statusCode).to.equal(undefined);
        expect(error.timeoutMs).to.equal(50);
        expect(error.cause).not.to.equal(undefined);
      });
    });
  });

  it("Preserves a known status when reading its error body fails", async () => {
    await withServer((_request, response) => {
      response.writeHead(503);
      response.write("partial");
    }, async (url) => {
      const emit = emitterFor(httpTransport(url, { timeoutMs: 50 }));
      await expectTransportError(emit(fixture), (error) => {
        expect(error.kind).to.equal("http-status");
        expect(error.statusCode).to.equal(503);
        expect(error.responseBody).to.equal("partial");
        expect(error.responseBodyTruncated).to.equal(true);
        expect(error.timeoutMs).to.equal(50);
        expect(error.cause).not.to.equal(undefined);
      });
    });
  });

  it("Reports a network failure with its cause", async () => {
    const unavailableUrl = await closedServerUrl();
    const emit = emitterFor(httpTransport(unavailableUrl));

    await expectTransportError(emit(fixture), (error) => {
      expect(error.kind).to.equal("network");
      expect(error.statusCode).to.equal(undefined);
      expect(error.timeoutMs).to.equal(undefined);
      expect(error.cause).not.to.equal(undefined);
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
    expect(() => httpTransport("https://events.example.com", {
      headers: { "invalid header": "value" },
    })).to.throw(TypeError);
  });
});

async function expectTransportError(
  emitted: Promise<void>, assertions: (error: HTTPTransportError) => void,
): Promise<void> {
  await rejects(emitted, (error: unknown) => {
    expect(error).to.be.instanceOf(HTTPTransportError);
    assertions(error as HTTPTransportError);
    return true;
  });
}

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
