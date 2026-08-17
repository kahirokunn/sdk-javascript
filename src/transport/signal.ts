/*
 Copyright 2021 The CloudEvents Authors
 SPDX-License-Identifier: Apache-2.0
*/

/**
 * Check a signal supplied by a caller, whether it was given to a transport, to a single send,
 * or to an emitter wrapper, by its platform brand rather than the interface prototype of this
 * realm
 *
 * @param {unknown} value the signal supplied by the caller, if any
 * @returns {AbortSignal|undefined} the signal, or undefined when none was supplied
 */
export function signalFrom(value: unknown): AbortSignal | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    // the getter checks the AbortSignal platform brand and accepts signals from another realm
    Reflect.get(AbortSignal.prototype, "aborted", value);
  } catch {
    throw new TypeError("options.signal must be an AbortSignal");
  }
  return value as AbortSignal;
}
