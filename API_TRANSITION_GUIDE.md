## Deprecated API Transition Guide

When APIs are deprecated, the following guide will show how to transition from removed APIs to the new ones


### Upgrading From 3.x to 4.0

In the 3.2.0 release, a few APIs were set to be deprecated in the 4.0 release.  With the release of 4.0.0,  those APIs have been removed.

#### Receiever

The `Receiver` class has been removed.

`Receiver.accept` should be transitioned to `HTTP.toEvent`

Here is an example of what a `HTTP.toEvent` might look like using Express.js

```js
const app = require("express")();
const { HTTP } = require("cloudevents");

app.post("/", (req, res) => {
  // body and headers come from an incoming HTTP request, e.g. express.js
  const receivedEvent = HTTP.toEvent({ headers: req.headers, body: req.body });
  console.log(receivedEvent);
});
```

#### Emitter

`Emit.send` should be transitioned to `HTTP.binary` for binary events and `HTTP.structured` for structured events

`Emit.send` would use axios to emit the events.  Since this now longer available, you are free to choose your own transport protocol.

So for axios,  it might look something like this:

```js
const axios = require('axios').default;
const { HTTP } = require("cloudevents");


const ce = new CloudEvent({ type, source, data })
const message = HTTP.binary(ce); // Or HTTP.structured(ce)

axios({
  method: 'post',
  url: '...',
  data: message.body,
  headers: message.headers,
});
```

You may also use the `emitterFor()` function as a convenience.

```js
const axios = require('axios').default;
const { emitterFor, Mode } = require("cloudevents");

function sendWithAxios(message) {
  // Do what you need with the message headers
  // and body in this function, then send the
  // event
  axios({
    method: 'post',
    url: '...',
    data: message.body,
    headers: message.headers,
  });
}

const emit = emitterFor(sendWithAxios, { mode: Mode.BINARY });
emit(new CloudEvent({ type, source, data }));
```

You may also use the `Emitter` singleton

```js
const axios = require("axios").default;
const { emitterFor, Mode, CloudEvent, Emitter } = require("cloudevents");

function sendWithAxios(message) {
  // Do what you need with the message headers
  // and body in this function, then send the
  // event
  axios({
    method: "post",
    url: "...",
    data: message.body,
    headers: message.headers,
  });
}

const emit = emitterFor(sendWithAxios, { mode: Mode.BINARY });
// Set the emit
Emitter.on("cloudevent", emit);

...
// In any part of the code will send the event
new CloudEvent({ type, source, data }).emit();

// You can also have several listener to send the event to several endpoint
```

### Upgrading From 10.x to 11.0

In the 11.0.0 release, the built-in HTTP transport was rewritten on top of the Fetch API.

#### HTTP Transport

`httpTransport()` used to resolve with the response for every status code, so a receiver
that rejected an event looked just like one that accepted it.

```js
const { emitterFor, httpTransport, CloudEvent } = require("cloudevents");

const emit = emitterFor(httpTransport("https://my.receiver.com/endpoint"));

// resolved with { body, headers } whether the receiver returned 202 or 503
const response = await emit(new CloudEvent({ type, source, data }));
console.log(response.headers, response.body);
```

It now resolves with no value on a 2xx response, and rejects with an `HTTPTransportError`
on anything else.  When the receiver did answer, the error carries the status, the response
headers and the response body, so what the old return value gave you is still there when it
matters.  Failures that never produced a response, which used to reject with whatever
`http.request` threw, are wrapped as well and keep the original error in `cause`; those
report only `kind` and `cause`, since there is no response to describe.

Options that the transport cannot use are rejected before anything is sent, with a plain
`TypeError` rather than an `HTTPTransportError`.

```js
const { emitterFor, httpTransport, HTTPTransportError, CloudEvent } = require("cloudevents");

const emit = emitterFor(httpTransport("https://my.receiver.com/endpoint"));

try {
  await emit(new CloudEvent({ type, source, data }));
} catch (error) {
  if (error instanceof HTTPTransportError) {
    // "http-status", "timeout", "aborted" or "network"
    console.error(error.kind, error.statusCode, error.headers, error.responseBody);
  }
  throw error;
}
```

`httpTransport()` also takes a second argument now, for headers, a timeout and an
`AbortSignal`.  Any other Fetch option goes under `fetchOptions` rather than beside them,
so redirects are followed with `{ fetchOptions: { redirect: "follow" } }` and not with
`{ redirect: "follow" }`.  See the [README](README.md) for the details.

If you would rather have the response of a successful send, write your own
`TransportFunction` and pass it to `emitterFor()` as shown above.
