/* Runs before any module: index.html loads it as a classic script ahead of the
 * app, and src/pdf/pdf.worker.ts imports it ahead of PDF.js's worker. Tauri
 * macOS uses the system WKWebView, and the oldest one Lattice supports
 * (macOS 14.0, Safari 17.0) lacks built-ins that PDF.js 6 and other
 * dependencies call, some at module top level (`Iterator.prototype`), where no
 * later fallback can catch the failure. Each install below is skipped where
 * the engine already has the method. scripts/check-webkit-compat.mjs evaluates
 * the built PDF.js chunks with these built-ins deleted and lists which of them
 * the bundles use; extend both together.
 *
 * React's development-only Components performance track recursively inspects
 * changed props. In WKWebView that inspection can reach an already-mounted
 * cross-origin Agent iframe, throw a SecurityError during commit, and leave
 * React's scheduler permanently inside the render context. Production React
 * does not install this track. Disable only that optional dev instrumentation
 * before react-dom evaluates; running this from main.tsx would be too late
 * because ESM dependencies execute first. */
(function () {
  "use strict";

  if (
    typeof document !== "undefined" &&
    typeof location !== "undefined" &&
    location.protocol === "http:" &&
    typeof navigator !== "undefined" &&
    /AppleWebKit/i.test(navigator.userAgent) &&
    typeof console !== "undefined" &&
    typeof console.timeStamp === "function"
  ) {
    try {
      console.timeStamp = undefined;
    } catch (_) {
      // A future WebKit may make the console property read-only. In that case
      // keep booting; the rest of the compatibility polyfills are still needed.
    }
  }

  /** Installs `value` as a non-enumerable method, as built-ins are, unless `target` has one. */
  function define(target, name, value) {
    if (target && typeof target[name] !== "function") {
      Object.defineProperty(target, name, { configurable: true, writable: true, value: value });
    }
  }

  /** The ToIndex conversion typed-array and buffer lengths go through. */
  function toIndex(value) {
    var number = value === undefined ? 0 : Math.trunc(Number(value)) || 0;
    if (number < 0 || number > Number.MAX_SAFE_INTEGER) throw new RangeError("Invalid length");
    return number;
  }

  // Map/WeakMap getOrInsert / getOrInsertComputed (Safari 26).
  [Map, typeof WeakMap === "undefined" ? undefined : WeakMap].forEach(function (Collection) {
    if (!Collection) return;
    define(Collection.prototype, "getOrInsert", function getOrInsert(key, defaultValue) {
      if (this.has(key)) return this.get(key);
      this.set(key, defaultValue);
      return defaultValue;
    });
    define(Collection.prototype, "getOrInsertComputed", function getOrInsertComputed(key, callback) {
      if (this.has(key)) return this.get(key);
      var value = callback(key);
      this.set(key, value);
      return value;
    });
  });

  // Promise.withResolvers (Safari 17.4) and Promise.try (Safari 18.2).
  define(Promise, "withResolvers", function withResolvers() {
    var resolve;
    var reject;
    var promise = new this(function (resolvePromise, rejectPromise) {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise: promise, resolve: resolve, reject: reject };
  });
  define(Promise, "try", function (callback) {
    var args = Array.prototype.slice.call(arguments, 1);
    // A synchronous throw from the callback rejects the promise, as the executor's would.
    return new this(function (resolve) {
      resolve(callback.apply(undefined, args));
    });
  });

  // The Iterator global and its helpers (Safari 18.4). Before it, iterators
  // share the prototype the helpers belong on, but no global names it.
  var IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  if (typeof globalThis.Iterator !== "function") {
    var IteratorConstructor = function Iterator() {
      if (new.target === undefined || new.target === IteratorConstructor) {
        throw new TypeError("Iterator cannot be constructed directly");
      }
    };
    IteratorConstructor.prototype = IteratorPrototype;
    Object.defineProperty(globalThis, "Iterator", { configurable: true, writable: true, value: IteratorConstructor });
  }

  /** GetIteratorDirect: the receiver, and its `next` read once. */
  function iteratorRecord(iterator) {
    if (Object(iterator) !== iterator) throw new TypeError("Iterator helper called on a non-object");
    return { iterator: iterator, next: iterator.next };
  }
  function step(record) {
    var result = record.next.call(record.iterator);
    if (Object(result) !== result) throw new TypeError("Iterator result is not an object");
    return result;
  }
  function closeIterator(iterator) {
    var close = iterator.return;
    if (close !== undefined && close !== null) close.call(iterator);
  }
  /** Calls `callback`; when it throws, closes the iterator before rethrowing, as the helpers must. */
  function callOrClose(record, callback, value, counter) {
    try {
      return callback(value, counter);
    } catch (error) {
      try {
        closeIterator(record.iterator);
      } catch (_) {
        // The callback's error wins over one from closing.
      }
      throw error;
    }
  }
  function requireCallable(callback) {
    if (typeof callback !== "function") throw new TypeError(String(callback) + " is not a function");
  }
  function toLimit(limit) {
    var number = Number(limit);
    if (number !== number) throw new RangeError("Iterator limit must be a number");
    number = Math.trunc(number);
    if (number < 0) throw new RangeError("Iterator limit must be non-negative");
    return number;
  }
  /*
   * The lazy helpers are generators: they already inherit from
   * IteratorPrototype and so chain. Each yields inside `try`, so a consumer's
   * early `return()` (a `break` out of `for...of`, a `find` that matched)
   * closes the underlying iterator; exhaustion and errors from `next` do not.
   */
  function* yieldOrClose(record, value) {
    var resumed = false;
    try {
      yield value;
      resumed = true;
    } finally {
      if (!resumed) closeIterator(record.iterator);
    }
  }
  function* mapIterator(record, mapper) {
    for (var counter = 0; ; counter++) {
      var result = step(record);
      if (result.done) return;
      yield* yieldOrClose(record, callOrClose(record, mapper, result.value, counter));
    }
  }
  function* filterIterator(record, predicate) {
    for (var counter = 0; ; counter++) {
      var result = step(record);
      if (result.done) return;
      if (callOrClose(record, predicate, result.value, counter)) yield* yieldOrClose(record, result.value);
    }
  }
  function* takeIterator(record, limit) {
    for (var remaining = limit; ; remaining--) {
      if (remaining === 0) {
        closeIterator(record.iterator);
        return;
      }
      var result = step(record);
      if (result.done) return;
      yield* yieldOrClose(record, result.value);
    }
  }
  function* dropIterator(record, limit) {
    for (var remaining = limit; remaining > 0; remaining--) {
      if (step(record).done) return;
    }
    for (;;) {
      var result = step(record);
      if (result.done) return;
      yield* yieldOrClose(record, result.value);
    }
  }
  function* flatMapIterator(record, mapper) {
    for (var counter = 0; ; counter++) {
      var result = step(record);
      if (result.done) return;
      var inner;
      try {
        inner = iteratorRecord(flattenable(callOrClose(record, mapper, result.value, counter)));
      } catch (error) {
        try {
          closeIterator(record.iterator);
        } catch (_) {
          // The mapper's error wins over one from closing.
        }
        throw error;
      }
      for (;;) {
        var innerResult = step(inner);
        if (innerResult.done) break;
        var resumed = false;
        try {
          yield innerResult.value;
          resumed = true;
        } finally {
          if (!resumed) {
            try {
              closeIterator(inner.iterator);
            } finally {
              closeIterator(record.iterator);
            }
          }
        }
      }
    }
  }
  /** GetIteratorFlattenable: an iterable's iterator, or the object itself; strings are rejected. */
  function flattenable(value) {
    if (Object(value) !== value) throw new TypeError("flatMap mapper must return an iterator or iterable");
    var method = value[Symbol.iterator];
    var iterator = method === undefined || method === null ? value : method.call(value);
    if (Object(iterator) !== iterator) throw new TypeError("Not an iterator");
    return iterator;
  }

  define(IteratorPrototype, "map", function map(mapper) {
    var record = iteratorRecord(this);
    requireCallable(mapper);
    return mapIterator(record, mapper);
  });
  define(IteratorPrototype, "filter", function filter(predicate) {
    var record = iteratorRecord(this);
    requireCallable(predicate);
    return filterIterator(record, predicate);
  });
  define(IteratorPrototype, "take", function take(limit) {
    var record = iteratorRecord(this);
    return takeIterator(record, toLimit(limit));
  });
  define(IteratorPrototype, "drop", function drop(limit) {
    var record = iteratorRecord(this);
    return dropIterator(record, toLimit(limit));
  });
  define(IteratorPrototype, "flatMap", function flatMap(mapper) {
    var record = iteratorRecord(this);
    requireCallable(mapper);
    return flatMapIterator(record, mapper);
  });
  define(IteratorPrototype, "reduce", function reduce(reducer) {
    var record = iteratorRecord(this);
    requireCallable(reducer);
    var counter = 0;
    var accumulator;
    if (arguments.length > 1) {
      accumulator = arguments[1];
    } else {
      var first = step(record);
      if (first.done) throw new TypeError("Reduce of empty iterator with no initial value");
      accumulator = first.value;
      counter = 1;
    }
    for (;; counter++) {
      var result = step(record);
      if (result.done) return accumulator;
      var previous = accumulator;
      accumulator = callOrClose(record, function (value, index) {
        return reducer(previous, value, index);
      }, result.value, counter);
    }
  });
  define(IteratorPrototype, "toArray", function toArray() {
    var record = iteratorRecord(this);
    var items = [];
    for (;;) {
      var result = step(record);
      if (result.done) return items;
      items.push(result.value);
    }
  });
  define(IteratorPrototype, "forEach", function forEach(callback) {
    var record = iteratorRecord(this);
    requireCallable(callback);
    for (var counter = 0; ; counter++) {
      var result = step(record);
      if (result.done) return undefined;
      callOrClose(record, callback, result.value, counter);
    }
  });
  /** The short-circuiting helpers: `stop(matched)` decides when `done(value)` ends the walk. */
  function search(iterator, predicate, stop, done, exhausted) {
    var record = iteratorRecord(iterator);
    requireCallable(predicate);
    for (var counter = 0; ; counter++) {
      var result = step(record);
      if (result.done) return exhausted;
      if (stop(callOrClose(record, predicate, result.value, counter))) {
        closeIterator(record.iterator);
        return done(result.value);
      }
    }
  }
  define(IteratorPrototype, "some", function some(predicate) {
    return search(this, predicate, Boolean, function () { return true; }, false);
  });
  define(IteratorPrototype, "every", function every(predicate) {
    return search(this, predicate, function (matched) { return !matched; }, function () { return false; }, true);
  });
  define(IteratorPrototype, "find", function find(predicate) {
    return search(this, predicate, Boolean, function (value) { return value; }, undefined);
  });

  /** Iterator.from's wrapper for an iterator that does not inherit from IteratorPrototype. */
  function* wrapIterator(record) {
    for (;;) {
      var result = step(record);
      if (result.done) return result.value;
      yield* yieldOrClose(record, result.value);
    }
  }
  define(globalThis.Iterator, "from", function from(value) {
    if (typeof value !== "string" && Object(value) !== value) throw new TypeError("Iterator.from requires an object or string");
    var method = Object(value)[Symbol.iterator];
    var iterator = method === undefined || method === null ? value : method.call(value);
    if (Object(iterator) !== iterator) throw new TypeError("Not an iterator");
    if (IteratorPrototype.isPrototypeOf(iterator)) return iterator;
    return wrapIterator(iteratorRecord(iterator));
  });

  // Math.sumPrecise (Safari 26): the exactly rounded sum, by Shewchuk's
  // expansion of non-overlapping partial sums (Python's math.fsum).
  function exactSum(values) {
    var partials = [];
    for (var index = 0; index < values.length; index++) {
      var x = values[index];
      var kept = 0;
      for (var p = 0; p < partials.length; p++) {
        var y = partials[p];
        if (Math.abs(x) < Math.abs(y)) {
          var swap = x;
          x = y;
          y = swap;
        }
        var high = x + y;
        if (!isFinite(high)) return high;
        var low = y - (high - x);
        if (low !== 0) partials[kept++] = low;
        x = high;
      }
      partials.length = kept;
      partials.push(x);
    }
    var n = partials.length;
    if (n === 0) return 0;
    var sum = partials[--n];
    var rest = 0;
    while (n > 0) {
      var previous = sum;
      var next = partials[--n];
      sum = previous + next;
      rest = next - (sum - previous);
      if (rest !== 0) break;
    }
    // Round half to even across the partials the loop stopped above.
    if (n > 0 && ((rest < 0 && partials[n - 1] < 0) || (rest > 0 && partials[n - 1] > 0))) {
      var doubled = rest * 2;
      var adjusted = sum + doubled;
      if (doubled === adjusted - sum) sum = adjusted;
    }
    return sum;
  }
  define(Math, "sumPrecise", function sumPrecise(items) {
    if (Object(items) !== items || typeof items[Symbol.iterator] !== "function") {
      throw new TypeError("Math.sumPrecise requires an iterable");
    }
    var finite = [];
    var special = 0;
    var allNegativeZero = true;
    for (var value of items) {
      if (typeof value !== "number") throw new TypeError("Math.sumPrecise: " + typeof value + " is not a number");
      if (!(value === 0 && 1 / value < 0)) allNegativeZero = false;
      if (isFinite(value)) finite.push(value);
      else special += value;
    }
    // NaN, an infinity, or opposite infinities (NaN) decide the sum alone.
    if (special !== 0) return special;
    if (allNegativeZero) return -0;
    var sum = exactSum(finite);
    if (isFinite(sum)) return sum;
    // A partial sum overflowed: halving is exact for all but subnormals, and
    // doubling back overflows only when the true sum does.
    return exactSum(finite.map(function (value) { return value / 2; })) * 2;
  });

  // RegExp.escape (Safari 18.4), per the spec's EncodeForRegExpEscape.
  var syntaxCharacters = "^$\\.*+?()[]{}|/";
  var otherPunctuators = ",-=<>#&!%:;@~'`\"";
  var controlEscapes = { 9: "t", 10: "n", 11: "v", 12: "f", 13: "r" };
  function isWhiteSpaceOrLineTerminator(code) {
    return code === 0x20 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
  }
  function hexEscape(code) {
    return code <= 0xff
      ? "\\x" + code.toString(16).padStart(2, "0")
      : "\\u" + code.toString(16).padStart(4, "0");
  }
  define(RegExp, "escape", function escape(string) {
    if (typeof string !== "string") throw new TypeError("RegExp.escape requires a string");
    var escaped = "";
    for (var index = 0; index < string.length; index++) {
      var character = string.charAt(index);
      var code = string.charCodeAt(index);
      if (index === 0 && /[0-9A-Za-z]/.test(character)) {
        escaped += hexEscape(code);
      } else if (syntaxCharacters.indexOf(character) >= 0) {
        escaped += "\\" + character;
      } else if (otherPunctuators.indexOf(character) >= 0) {
        escaped += hexEscape(code);
      } else if (controlEscapes[code]) {
        escaped += "\\" + controlEscapes[code];
      } else if (isWhiteSpaceOrLineTerminator(code)) {
        escaped += hexEscape(code);
      } else if (code >= 0xd800 && code <= 0xdfff) {
        var nextCode = string.charCodeAt(index + 1);
        if (code <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff) {
          escaped += character + string.charAt(++index);
        } else {
          escaped += hexEscape(code);
        }
      } else {
        escaped += character;
      }
    }
    return escaped;
  });

  // Uint8Array base64/hex (Safari 18.2).
  var base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function readOptions(options) {
    if (options === undefined) return {};
    if (Object(options) !== options) throw new TypeError("Options must be an object");
    return options;
  }
  function readAlphabet(options) {
    var alphabet = options.alphabet === undefined ? "base64" : options.alphabet;
    if (alphabet !== "base64" && alphabet !== "base64url") throw new TypeError("Invalid alphabet");
    return alphabet === "base64" ? base64Alphabet : base64UrlAlphabet;
  }
  function requireUint8Array(value) {
    if (Object.prototype.toString.call(value) !== "[object Uint8Array]") throw new TypeError("Receiver must be a Uint8Array");
  }
  function isAsciiWhiteSpace(character) {
    return character === " " || character === "\t" || character === "\n" || character === "\f" || character === "\r";
  }
  define(Uint8Array, "fromBase64", function fromBase64(string, options) {
    if (typeof string !== "string") throw new TypeError("Uint8Array.fromBase64 requires a string");
    options = readOptions(options);
    var alphabet = readAlphabet(options);
    var lastChunkHandling = options.lastChunkHandling === undefined ? "loose" : options.lastChunkHandling;
    if (lastChunkHandling !== "loose" && lastChunkHandling !== "strict" && lastChunkHandling !== "stop-before-partial") {
      throw new TypeError("Invalid lastChunkHandling");
    }
    var bytes = [];
    var chunk = [];
    var index = 0;
    function emit(sextets) {
      var bits = (sextets[0] << 18) | (sextets[1] << 12) | ((sextets[2] || 0) << 6) | (sextets[3] || 0);
      bytes.push((bits >> 16) & 0xff);
      if (sextets.length > 2) bytes.push((bits >> 8) & 0xff);
      if (sextets.length > 3) bytes.push(bits & 0xff);
    }
    for (; index < string.length; index++) {
      var character = string.charAt(index);
      if (isAsciiWhiteSpace(character)) continue;
      if (character === "=") break;
      var sextet = alphabet.indexOf(character);
      if (sextet < 0) throw new SyntaxError("Invalid base64 character");
      chunk.push(sextet);
      if (chunk.length === 4) {
        emit(chunk);
        chunk = [];
      }
    }
    if (index < string.length) {
      // Padding: it completes a chunk of two or three characters, and only
      // whitespace may follow it.
      if (chunk.length < 2) throw new SyntaxError("Unexpected base64 padding");
      var padding = chunk.length === 2 ? 2 : 1;
      for (; index < string.length; index++) {
        var trailing = string.charAt(index);
        if (isAsciiWhiteSpace(trailing)) continue;
        if (trailing !== "=" || padding === 0) throw new SyntaxError("Unexpected character after base64 padding");
        padding--;
      }
      if (padding !== 0) throw new SyntaxError("Incomplete base64 padding");
      if (lastChunkHandling === "strict" && chunk[chunk.length - 1] & (chunk.length === 2 ? 0xf : 0x3)) {
        throw new SyntaxError("Non-zero padding bits");
      }
      emit(chunk);
    } else if (chunk.length) {
      if (lastChunkHandling === "strict") throw new SyntaxError("Missing base64 padding");
      if (lastChunkHandling === "loose") {
        if (chunk.length === 1) throw new SyntaxError("Incomplete base64 chunk");
        emit(chunk);
      }
    }
    return new Uint8Array(bytes);
  });
  define(Uint8Array.prototype, "toBase64", function toBase64(options) {
    requireUint8Array(this);
    options = readOptions(options);
    var alphabet = readAlphabet(options);
    var omitPadding = Boolean(options.omitPadding);
    var encoded = "";
    for (var index = 0; index < this.length; index += 3) {
      var remaining = this.length - index;
      var bits = (this[index] << 16) | ((remaining > 1 ? this[index + 1] : 0) << 8) | (remaining > 2 ? this[index + 2] : 0);
      encoded += alphabet.charAt((bits >> 18) & 63) + alphabet.charAt((bits >> 12) & 63);
      encoded += remaining > 1 ? alphabet.charAt((bits >> 6) & 63) : omitPadding ? "" : "=";
      encoded += remaining > 2 ? alphabet.charAt(bits & 63) : omitPadding ? "" : "=";
    }
    return encoded;
  });
  define(Uint8Array.prototype, "toHex", function toHex() {
    requireUint8Array(this);
    var hex = "";
    for (var index = 0; index < this.length; index++) hex += (this[index] < 16 ? "0" : "") + this[index].toString(16);
    return hex;
  });
  define(Uint8Array, "fromHex", function fromHex(string) {
    if (typeof string !== "string") throw new TypeError("Uint8Array.fromHex requires a string");
    if (string.length % 2 !== 0 || /[^0-9a-fA-F]/.test(string)) throw new SyntaxError("Invalid hex string");
    var bytes = new Uint8Array(string.length / 2);
    for (var index = 0; index < bytes.length; index++) bytes[index] = parseInt(string.slice(index * 2, index * 2 + 2), 16);
    return bytes;
  });

  // ArrayBuffer.prototype.transferToFixedLength (Safari 17.4). A structured
  // clone that transfers the buffer detaches it, as the method must, and
  // moves its bytes without copying.
  if (typeof ArrayBuffer !== "undefined" && typeof structuredClone === "function") {
    define(ArrayBuffer.prototype, "transferToFixedLength", function transferToFixedLength(newLength) {
      if (Object.prototype.toString.call(this) !== "[object ArrayBuffer]") throw new TypeError("Receiver must be an ArrayBuffer");
      var length = newLength === undefined ? this.byteLength : toIndex(newLength);
      var moved = structuredClone(this, { transfer: [this] });
      if (length === moved.byteLength && !moved.resizable) return moved;
      var resized = new ArrayBuffer(length);
      new Uint8Array(resized).set(new Uint8Array(moved, 0, Math.min(length, moved.byteLength)));
      return resized;
    });
  }

  // URL.parse (Safari 18).
  if (typeof URL !== "undefined") {
    define(URL, "parse", function parse(url, base) {
      try {
        return new URL(url, base);
      } catch (_) {
        return null;
      }
    });
  }

  // AbortSignal.any (Safari 17.4). Listeners on the sources go away with the
  // combined signal's abort; until then a long-lived source keeps them.
  if (typeof AbortSignal !== "undefined" && typeof AbortController !== "undefined") {
    define(AbortSignal, "any", function any(signals) {
      var sources = Array.from(signals);
      var controller = new AbortController();
      for (var index = 0; index < sources.length; index++) {
        if (sources[index].aborted) {
          controller.abort(sources[index].reason);
          return controller.signal;
        }
      }
      sources.forEach(function (source) {
        source.addEventListener("abort", function () {
          controller.abort(source.reason);
        }, { once: true, signal: controller.signal });
      });
      return controller.signal;
    });
  }

  // Body.bytes() on Response, Request and Blob (Safari 18).
  function bytes() {
    return this.arrayBuffer().then(function (buffer) {
      return new Uint8Array(buffer);
    });
  }
  ["Response", "Request", "Blob"].forEach(function (name) {
    if (typeof globalThis[name] === "function") define(globalThis[name].prototype, "bytes", bytes);
  });

  // ReadableStream async iteration (Safari 26): `for await` over a stream,
  // which PDF.js uses to stream text content and to inflate data. Leaving the
  // loop early cancels the stream unless `preventCancel` is set.
  if (typeof ReadableStream !== "undefined" && typeof ReadableStream.prototype[Symbol.asyncIterator] !== "function") {
    var values = async function* values(options) {
      var preventCancel = Boolean(options && options.preventCancel);
      var reader = this.getReader();
      var settled = false;
      try {
        for (;;) {
          var result;
          try {
            result = await reader.read();
          } catch (error) {
            settled = true;
            throw error;
          }
          if (result.done) {
            settled = true;
            return;
          }
          yield result.value;
        }
      } finally {
        if (!settled && !preventCancel) await reader.cancel();
        reader.releaseLock();
      }
    };
    define(ReadableStream.prototype, "values", values);
    define(ReadableStream.prototype, Symbol.asyncIterator, values);
  }
})();
