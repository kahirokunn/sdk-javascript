/*
 Copyright 2021 The CloudEvents Authors
 SPDX-License-Identifier: Apache-2.0
*/

import { Headers as CloudEventHeaders, Message } from "../../message";
import { Options, TransportFunction } from "../emitter";

/**
 * Options applied to every request sent by an HTTP transport
 */
export interface HTTPTransportOptions {
  /**
   * Abort the request after this many milliseconds, including the time spent reading
   * the body of an error response. Omit it to send without a timeout
   */
  timeoutMs?: number;
  /** HTTP headers applied to every request, per-send headers take precedence */
  headers?: CloudEventHeaders;
  /** Aborts every request sent by this transport, combined with `timeoutMs` and the per-send signal */
  signal?: AbortSignal;
  /** Fetch options applied to every request, apart from the ones this transport controls */
  fetchOptions?: Omit<RequestInit, "method" | "headers" | "body" | "signal">;
}

/**
 * The failure category reported by {@linkcode HTTPTransportError}
 *
 * - `http-status`: the sink returned a response that was not 2xx
 * - `timeout`: `timeoutMs` elapsed before the request completed
 * - `aborted`: a signal supplied by the caller aborted the request
 * - `network`: the request never produced a response, e.g. DNS, connection, or TLS failure
 */
export type HTTPTransportErrorKind = "http-status" | "timeout" | "aborted" | "network";

/**
 * What an {@linkcode HTTPTransportError} reports alongside its {@linkcode HTTPTransportErrorKind}
 */
export type HTTPTransportErrorDetails =
  Pick<HTTPTransportError, "statusCode" | "headers" | "responseBody" | "timeoutMs" | "cause">;

/**
 * A request failure reported by the built-in HTTP transport
 */
export class HTTPTransportError extends Error {
  /** The failure category */
  readonly kind: HTTPTransportErrorKind;
  /** The status of a response that was not 2xx, absent for every other kind */
  readonly statusCode?: number;
  /** The response headers, lower cased, present when a response was received */
  readonly headers?: Readonly<Record<string, string>>;
  /** The response body as text, absent when it could not be read */
  readonly responseBody?: string;
  /** The timeout that elapsed, present when a timeout ended the request or its body read */
  readonly timeoutMs?: number;
  /** The underlying failure, e.g. what fetch threw or the reason carried by a signal */
  readonly cause?: unknown;

  constructor(kind: HTTPTransportErrorKind, details: HTTPTransportErrorDetails = {}) {
    super(errorMessage(kind, details));
    this.name = "HTTPTransportError";
    this.kind = kind;
    this.statusCode = details.statusCode;
    this.headers = details.headers;
    this.responseBody = details.responseBody;
    this.timeoutMs = details.timeoutMs;
    this.cause = details.cause;
  }
}

/**
 * httpTransport provides a simple HTTP Transport function, which can send a CloudEvent,
 * encoded as a Message to the endpoint. The returned function can be used with emitterFor()
 * to provide an event emitter, for example:
 *
 * const emit = emitterFor(httpTransport("http://example.com"));
 * emit(myCloudEvent)
 *    .catch(err => console.error(err.kind, err.statusCode));
 *
 * The event is sent once, without retries. A response that is not 2xx rejects with an
 * {@linkcode HTTPTransportError} holding the status, the headers and the text the sink sent
 * back. Redirects are reported as errors unless `fetchOptions.redirect` says otherwise, since
 * Fetch keeps the CloudEvent POST only for 307 and 308 - see the README for the details.
 *
 * @param {string|URL} sink the destination endpoint for the event
 * @param {HTTPTransportOptions} options headers, Fetch options, timeout and abort behavior
 * @returns {TransportFunction<void>} a function which can be used to send CloudEvents to _sink_
 */
export function httpTransport(sink: string | URL, options: HTTPTransportOptions = {}): TransportFunction<void> {
  const url = validateHTTPURL(sink);
  const timeoutMs = options.timeoutMs === undefined ? undefined : validateTimeoutMs(options.timeoutMs);
  const transportSignal = signalFrom(options.signal);
  const transportHeaders = headersFrom(options.headers);
  const fetchOptions: RequestInit = {
    ...options.fetchOptions,
    // an explicitly undefined redirect is absent as far as fetch is concerned, which would
    // leave it following redirects, so the default is applied after the caller's options
    redirect: options.fetchOptions?.redirect ?? "manual",
    method: "POST",
  };

  return async function send(message: Message, sendOptions?: Options): Promise<void> {
    // checked before any timer or listener exists, so a bad option is a plain TypeError
    // rather than a send which appears to have failed on the network
    const sendSignal = signalFrom(sendOptions?.signal);
    const headers = requestHeaders(message.headers, transportHeaders, headersFrom(sendOptions?.headers));
    const timeoutSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const { signal, dispose } = combineSignals(timeoutSignal, transportSignal, sendSignal);

    // the timeout belongs to this transport, so it is reported ahead of a caller's abort
    const requestFailure = (cause: unknown): HTTPTransportError => {
      if (timeoutSignal?.aborted) {
        return new HTTPTransportError("timeout", { timeoutMs, cause: timeoutSignal.reason ?? cause });
      }
      const aborted = [transportSignal, sendSignal].find((candidate) => candidate?.aborted);
      if (aborted) {
        return new HTTPTransportError("aborted", { cause: aborted.reason ?? cause });
      }
      return new HTTPTransportError("network", { cause });
    };

    try {
      let response: Response;
      try {
        response = await fetch(url, {
          ...fetchOptions,
          headers,
          body: message.body as BodyInit,
          signal,
        });
      } catch (cause) {
        throw requestFailure(cause);
      }

      if (response.ok) {
        if (response.body) {
          await cancelQuietly(response.body);
        }
        return;
      }

      let responseBody: string | undefined;
      let bodyReadCause: unknown;
      try {
        responseBody = await response.text();
      } catch (cause) {
        bodyReadCause = cause;
      }
      const bodyReadTimedOut = bodyReadCause !== undefined && timeoutSignal?.aborted;
      throw new HTTPTransportError("http-status", {
        statusCode: response.status,
        headers: responseHeaders(response.headers),
        responseBody,
        timeoutMs: bodyReadTimedOut ? timeoutMs : undefined,
        cause: bodyReadCause,
      });
    } finally {
      dispose();
    }
  };
}

/**
 * Check that the sink is a URL this transport knows how to POST to
 *
 * @param {string|URL} sink the destination endpoint for the event
 * @returns {URL} the parsed sink
 */
function validateHTTPURL(sink: string | URL): URL {
  const url = new URL(sink);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`unsupported protocol ${url.protocol}`);
  }
  return url;
}

/**
 * Check that a timeout is a positive whole number of milliseconds
 *
 * @param {number} value the timeout to check
 * @returns {number} the timeout
 */
function validateTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  return value;
}

/**
 * Check a signal supplied by a caller, either for this transport or for a single send
 *
 * @param {unknown} value the signal supplied by the caller, if any
 * @returns {AbortSignal|undefined} the signal, or undefined when none was supplied
 */
function signalFrom(value: unknown): AbortSignal | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!(value instanceof AbortSignal)) {
    throw new TypeError("options.signal must be an AbortSignal");
  }
  return value;
}

/**
 * An abort signal for a single request, with the cleanup that goes with it
 */
interface CombinedSignal {
  /** The signal to hand to fetch, undefined when nothing can abort the request */
  signal?: AbortSignal;
  /** Detaches the listeners this signal needed */
  dispose(): void;
}

/**
 * Combine abort signals into one. AbortSignal.any() is newer than the TypeScript lib this
 * package builds against, so this does it by hand. Callers have to dispose() once the request
 * is done, otherwise a long lived signal collects one listener per event sent
 *
 * @param {AbortSignal} signals the signals to combine, undefined ones are ignored
 * @returns {CombinedSignal} the combined signal and the cleanup it needs
 */
function combineSignals(...signals: (AbortSignal | undefined)[]): CombinedSignal {
  const sources = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (sources.length < 2) {
    return { signal: sources[0], dispose: () => undefined };
  }

  const controller = new AbortController();
  const detach: (() => void)[] = [];
  for (const source of sources) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const abort = () => controller.abort(source.reason);
    source.addEventListener("abort", abort, { once: true });
    detach.push(() => source.removeEventListener("abort", abort));
  }

  return {
    signal: controller.signal,
    dispose: () => detach.forEach((remove) => remove()),
  };
}

/**
 * Merge the headers for a single request
 *
 * @param {CloudEventHeaders} messageHeaders the headers of the event Message
 * @param {Headers} transportHeaders the headers configured on this transport, if any
 * @param {Headers} sendHeaders the headers supplied with this send, if any
 * @returns {Headers} the headers to send
 */
function requestHeaders(
  messageHeaders: CloudEventHeaders, transportHeaders?: Headers, sendHeaders?: Headers,
): Headers {
  const headers = new Headers();
  // lowest precedence first - the CloudEvent binding, then the transport, then this send
  setHeaders(headers, messageHeaders);
  setHeaders(headers, transportHeaders);
  setHeaders(headers, sendHeaders);
  return headers;
}

/**
 * Check the headers a caller supplied, either for this transport or for a single send. This
 * is not applied to the headers of the Message, which are whatever the binding produced
 *
 * @param {unknown} source the headers supplied by the caller, if any
 * @returns {Headers|undefined} the headers, or undefined when none were supplied
 */
function headersFrom(source: unknown): Headers | undefined {
  if (source === undefined || source === null) {
    return undefined;
  }
  // a Headers instance yields nothing from Object.entries(), an array yields index names
  if (typeof source !== "object" || Array.isArray(source) || source instanceof Headers) {
    throw new TypeError("options.headers must be an object of header names and values");
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || value === null) {
      continue;
    }
    // a header can hold several values, e.g. set-cookie
    if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
      continue;
    }
    if (typeof value === "object") {
      throw new TypeError(`header ${name} must be a string, a number, a boolean or an array`);
    }
    headers.set(name, String(value));
  }
  return headers;
}

/**
 * Copy headers onto a target, replacing any that are already there
 *
 * @param {Headers} target the headers being built
 * @param {CloudEventHeaders|Headers} source the headers to copy, undefined ones are ignored
 * @returns {void}
 */
function setHeaders(target: Headers, source?: CloudEventHeaders | Headers): void {
  if (source === undefined) {
    return;
  }
  if (source instanceof Headers) {
    source.forEach((value, name) => target.set(name, value));
    return;
  }
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined) {
      target.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
  }
}

/**
 * Take a snapshot of the response headers to hand to the caller
 *
 * @param {Headers} headers the headers of the response
 * @returns {Readonly<Record<string, string>>} the header names, lower cased, and their values
 */
function responseHeaders(headers: Headers): Readonly<Record<string, string>> {
  // Object.fromEntries() is not in the es2016 lib the browser build uses
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
  return Object.freeze(result);
}

/**
 * Release the body of a response that will not be read, ignoring any failure to do so
 *
 * @param {ReadableStream} source the response body to release
 * @returns {Promise} a promise which resolves once the body has been released
 */
async function cancelQuietly(source: ReadableStream): Promise<void> {
  await source.cancel().catch(() => undefined);
}

/**
 * Build the message for an {@linkcode HTTPTransportError}
 *
 * @param {HTTPTransportErrorKind} kind the failure category
 * @param {HTTPTransportErrorDetails} details what is known about the failure
 * @returns {string} the error message
 */
function errorMessage(kind: HTTPTransportErrorKind, details: HTTPTransportErrorDetails): string {
  switch (kind) {
    case "http-status":
      return `HTTP transport received a non-2xx response: ${details.statusCode}`;
    case "timeout":
      return `HTTP transport timed out after ${details.timeoutMs} ms`;
    case "aborted":
      return "HTTP transport request was aborted";
    case "network":
    // a caller can construct this class with any kind, so the default covers those too
    default:
      return "HTTP transport request failed";
  }
}
