/*
 Copyright 2021 The CloudEvents Authors
 SPDX-License-Identifier: Apache-2.0
*/

import { Message } from "../../message";
import { Options, TransportFunction } from "../emitter";

const DEFAULT_MAX_ERROR_BODY_BYTES = 65_536;

/** Options applied to every request sent by an HTTP transport. */
export interface HTTPTransportOptions {
  /** Abort the request after this many milliseconds. Omit to disable the SDK timeout. */
  timeoutMs?: number;
  /** Maximum number of response-body bytes retained for an HTTP status error. */
  maxErrorBodyBytes?: number;
  /** Return redirects as errors, or follow them using Fetch redirect semantics. */
  redirect?: "manual" | "follow";
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
 * @param {HTTPTransportOptions} options request timeout, redirect, and error-body options
 * @returns {TransportFunction<void>} a function that resolves when the sink returns 2xx
 */
export function httpTransport(
  sink: string | URL, options: HTTPTransportOptions = {},
): TransportFunction<void> {
  const url = validateSink(sink);
  const timeoutMs = validatePositiveInteger("timeoutMs", options.timeoutMs);
  const maxErrorBodyBytes = validateNonNegativeInteger(
    "maxErrorBodyBytes", options.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES,
  );
  const redirect = validateRedirect(options.redirect);

  return async function send(message: Message, sendOptions?: Options): Promise<void> {
    const signal = timeoutSignal(timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: requestHeaders(message.headers, sendOptions?.headers),
        body: message.body as BodyInit,
        redirect,
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
      await response.body?.cancel().catch(() => undefined);
      return;
    }

    const errorBody = await readErrorBody(response, maxErrorBodyBytes);
    const bodyReadTimedOut = errorBody.cause !== undefined && signal?.aborted === true;
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

function validatePositiveInteger(name: string, value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateNonNegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function validateRedirect(value: HTTPTransportOptions["redirect"]): "manual" | "follow" {
  if (value === undefined) {
    return "manual";
  }
  if (value !== "manual" && value !== "follow") {
    throw new TypeError("redirect must be either \"manual\" or \"follow\"");
  }
  return value;
}

function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  return AbortSignal.timeout(timeoutMs);
}

function requestHeaders(messageHeaders: unknown, optionHeaders: unknown): Headers {
  const headers = new Headers();
  setHeaders(headers, messageHeaders);
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

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let remaining = maxBytes;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return { body: body + decoder.decode(), truncated: false };
      }

      if (result.value.byteLength > remaining) {
        body += decoder.decode(result.value.subarray(0, remaining), { stream: true });
        body += decoder.decode();
        await reader.cancel().catch(() => undefined);
        return { body, truncated: true };
      }

      body += decoder.decode(result.value, { stream: true });
      remaining -= result.value.byteLength;
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    return { body: body + decoder.decode(), truncated: true, cause };
  }
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
