/*
 Copyright 2021 The CloudEvents Authors
 SPDX-License-Identifier: Apache-2.0
*/

import { Headers as CloudEventHeaders, Message } from "../../message";
import { Options, TransportFunction } from "../emitter";

const DEFAULT_MAX_ERROR_BODY_BYTES = 65_536;

/** Options applied to every request sent by an HTTP transport. */
export interface HTTPTransportOptions {
  /** Abort the request after this many milliseconds. Omit to disable the SDK timeout. */
  timeoutMs?: number;
  /** Maximum number of response-body bytes retained for an HTTP status error. */
  maxErrorBodyBytes?: number;
  /** HTTP headers applied to every request. Per-send headers take precedence. */
  headers?: HeadersInit;
  /** Fetch options applied to every request, except fields managed by the SDK. */
  fetchOptions?: Omit<RequestInit, "method" | "headers" | "body" | "signal">;
}

/** The failure category reported by {@linkcode HTTPTransportError}. */
export type HTTPTransportErrorKind = "http-status" | "timeout" | "network";

interface HTTPTransportErrorDetails {
  statusCode?: number;
  headers?: Readonly<Record<string, string>>;
  responseBody?: string;
  responseBodyTruncated?: boolean;
  timeoutMs?: number;
  cause?: unknown;
}

/** A request failure reported by the built-in HTTP transport. */
export class HTTPTransportError extends Error {
  readonly kind: HTTPTransportErrorKind;
  readonly statusCode?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly responseBody?: string;
  readonly responseBodyTruncated: boolean;
  readonly timeoutMs?: number;
  readonly cause?: unknown;

  constructor(kind: HTTPTransportErrorKind, details: HTTPTransportErrorDetails = {}) {
    super(errorMessage(kind, details));
    this.name = "HTTPTransportError";
    this.kind = kind;
    this.statusCode = details.statusCode;
    this.headers = details.headers;
    this.responseBody = details.responseBody;
    this.responseBodyTruncated = details.responseBodyTruncated ?? false;
    this.timeoutMs = details.timeoutMs;
    this.cause = details.cause;
  }
}

interface ErrorBody {
  body: string;
  truncated: boolean;
  cause?: unknown;
}

/**
 * Creates a transport function that sends one CloudEvent HTTP request to the sink.
 * Use the returned function with {@linkcode emitterFor}.
 *
 * @param {string|URL} sink destination endpoint for the event
 * @param {HTTPTransportOptions} options request headers, Fetch, timeout, and error-body options
 * @returns {TransportFunction<void>} a function that resolves when the sink returns 2xx
 */
export function httpTransport(
  sink: string | URL, options: HTTPTransportOptions = {},
): TransportFunction<void> {
  const url = validateSink(sink);
  const timeoutMs = options.timeoutMs === undefined
    ? undefined
    : validateInteger("timeoutMs", options.timeoutMs, 1);
  const maxErrorBodyBytes = validateInteger(
    "maxErrorBodyBytes", options.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES, 0,
  );
  const transportHeaders = new Headers(options.headers);
  const fetchOptions: RequestInit = {
    ...options.fetchOptions,
    redirect: options.fetchOptions?.redirect ?? "manual",
  };

  return async function send(message: Message, sendOptions?: Options): Promise<void> {
    const signal = timeoutSignal(timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        ...fetchOptions,
        method: "POST",
        headers: requestHeaders(message.headers, transportHeaders, sendOptions?.headers),
        body: message.body as BodyInit,
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) {
        throw new HTTPTransportError("timeout", {
          timeoutMs,
          cause: signal.reason ?? cause,
        });
      }
      throw new HTTPTransportError("network", { cause });
    }

    if (response.ok) {
      if (response.body) {
        await cancelQuietly(response.body);
      }
      return;
    }

    const errorBody = await readErrorBody(response, maxErrorBodyBytes);
    const bodyReadTimedOut = errorBody.cause !== undefined && signal?.aborted;
    throw new HTTPTransportError("http-status", {
      statusCode: response.status,
      headers: responseHeaders(response.headers),
      responseBody: errorBody.body,
      responseBodyTruncated: errorBody.truncated,
      timeoutMs: bodyReadTimedOut ? timeoutMs : undefined,
      cause: errorBody.cause,
    });
  };
}

function validateSink(sink: string | URL): URL {
  const url = new URL(sink);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`unsupported protocol ${url.protocol}`);
  }
  return url;
}

function validateInteger(name: string, value: number, minimum: 0 | 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a ${minimum === 1 ? "positive" : "non-negative"} safe integer`);
  }
  return value;
}

function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  return AbortSignal.timeout(timeoutMs);
}

function requestHeaders(
  messageHeaders: CloudEventHeaders, transportHeaders: Headers, optionHeaders: unknown,
): Headers {
  const headers = new Headers();
  setHeaders(headers, messageHeaders);
  transportHeaders.forEach((value, name) => headers.set(name, value));
  setHeaders(headers, optionHeaders);
  return headers;
}

function setHeaders(target: Headers, source: unknown): void {
  if (source === null || typeof source !== "object") {
    return;
  }
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined) {
      target.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
  }
}

function responseHeaders(headers: Headers): Readonly<Record<string, string>> {
  // Object.fromEntries() is unavailable in the browser build's ES2016 lib.
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
  return Object.freeze(result);
}

async function readErrorBody(response: Response, maxBytes: number): Promise<ErrorBody> {
  if (response.body === null) {
    return { body: "", truncated: false };
  }
  if (maxBytes === 0) {
    // Nothing would be retained, so don't wait for the body we are about to discard.
    await cancelQuietly(response.body);
    return { body: "", truncated: true };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let remaining = maxBytes;
  let truncated = false;
  let cause: unknown;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      truncated = value.byteLength > remaining;
      body += decoder.decode(truncated ? value.subarray(0, remaining) : value, { stream: true });
      remaining -= value.byteLength;
      if (truncated) {
        break;
      }
    }
  } catch (error) {
    truncated = true;
    cause = error;
  } finally {
    await cancelQuietly(reader);
  }

  return { body: body + decoder.decode(), truncated, cause };
}

// Releases a stream without letting a late failure mask the error being reported.
async function cancelQuietly(source: { cancel(): Promise<void> }): Promise<void> {
  await source.cancel().catch(() => undefined);
}

function errorMessage(kind: HTTPTransportErrorKind, details: HTTPTransportErrorDetails): string {
  switch (kind) {
    case "http-status":
      return `HTTP transport received a non-2xx response: ${details.statusCode}`;
    case "timeout":
      return `HTTP transport timed out after ${details.timeoutMs} ms`;
    case "network":
      return "HTTP transport request failed";
  }
}
