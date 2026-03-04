/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * find-ores.worker-local.js — READABLE / DE-MINIFIED VERSION
 *
 * This file is a Web Worker that exposes a `findOres` function via the
 * Comlink RPC library.  It uses a Rust/WebAssembly back-end to locate ore
 * clusters inside a Minecraft world given a seed, position, and filter
 * parameters.
 *
 * DEPLOYMENT NOTE:
 * ─────────────────
 * In the original app (orefinder.gg), this entire worker script — including
 * the Rust/WASM binary for ore finding — is bundled together and base64-
 * encoded as the `_WORKER_B64_` constant in index.html.  At runtime, index.html
 * decodes it, creates a Blob URL, and instantiates a Worker from it.
 *
 * The `import("./rust-local.js")` call seen in findOres() is an artefact of
 * the de-minification process.  In the actual bundled code the WASM bytes are
 * inlined (e.g. as a base64 data URL), so no external file is ever fetched.
 * The entire app is self-contained in a single index.html with no external
 * JS/WASM dependencies.
 *
 * High-level structure
 * ─────────────────────
 *  1.  Comlink  – thin RPC layer over MessageChannel / postMessage
 *  2.  Long.js  – 64-bit integer arithmetic (needed for Minecraft seeds)
 *  3.  Ore metadata – per-ore config objects (labels, sizing, images, etc.)
 *  4.  findOres – the main async function called from the main thread
 */

// ============================================================
// SECTION 1 – COMLINK (MessageChannel RPC)
// ============================================================

/** Symbols used as "branded" property keys by Comlink */
const COMLINK_PROXY     = Symbol("Comlink.proxy");
const COMLINK_ENDPOINT  = Symbol("Comlink.endpoint");
const COMLINK_RELEASE   = Symbol("Comlink.releaseProxy");
const COMLINK_FINALIZER = Symbol("Comlink.finalizer");
const COMLINK_THROWN    = Symbol("Comlink.thrown");

/**
 * Return true when a value could potentially be an object or function
 * (i.e. something that can have Symbol properties applied to it).
 */
const isObject = (val) =>
  (typeof val === "object" && val !== null) || typeof val === "function";

// ── Transfer handlers ──────────────────────────────────────

/**
 * "proxy" transfer-handler: wraps a value that was marked with the
 * Comlink.proxy symbol so it travels over the channel as a MessagePort.
 */
const proxyTransferHandler = {
  canHandle: (val) => isObject(val) && val[COMLINK_PROXY],

  serialize(val) {
    const { port1, port2 } = new MessageChannel();
    expose(val, port1);                // expose the value on port1
    return [port2, [port2]];           // transfer port2 to the other side
  },

  deserialize(port) {
    port.start();
    return createProxy(port);
  },
};

/**
 * "throw" transfer-handler: serialises thrown Error/values so they can
 * be reconstructed on the caller side and re-thrown.
 */
const throwTransferHandler = {
  canHandle: (val) => isObject(val) && COMLINK_THROWN in val,

  serialize({ value }) {
    let payload;
    if (value instanceof Error) {
      payload = {
        isError: true,
        value: {
          message: value.message,
          name:    value.name,
          stack:   value.stack,
        },
      };
    } else {
      payload = { isError: false, value };
    }
    return [payload, []];
  },

  deserialize(payload) {
    // Always throws – calling code must catch
    throw payload.isError
      ? Object.assign(new Error(payload.value.message), payload.value)
      : payload.value;
  },
};

/** Registry of all built-in transfer handlers, keyed by name */
const transferHandlers = new Map([
  ["proxy", proxyTransferHandler],
  ["throw", throwTransferHandler],
]);

// ── Origin checking ────────────────────────────────────────

/**
 * Returns true if `origin` is allowed by the `allowedOrigins` list.
 * Each entry may be: a string (exact match or "*"), or a RegExp.
 */
function isAllowedOrigin(allowedOrigins, origin) {
  for (const allowed of allowedOrigins) {
    if (origin === allowed || allowed === "*" || (allowed instanceof RegExp && allowed.test(origin))) {
      return true;
    }
  }
  return false;
}

// ── expose() – make an object callable from another thread ─

/**
 * Expose `obj` on the given `endpoint` (a MessagePort, Worker, etc.).
 * Incoming messages are dispatched as GET / SET / APPLY / CONSTRUCT /
 * ENDPOINT / RELEASE operations.
 *
 * @param {object}   obj           - The object to expose
 * @param {object}   endpoint      - A MessagePort-like object
 * @param {Array}    allowedOrigins - Origins permitted to call this endpoint
 */
function expose(obj, endpoint = globalThis, allowedOrigins = ["*"]) {
  endpoint.addEventListener("message", function handler(event) {
    // Ignore empty events
    if (!event || !event.data) return;

    // Block disallowed origins
    if (!isAllowedOrigin(allowedOrigins, event.origin)) {
      console.warn(`Invalid origin '${event.origin}' for comlink proxy`);
      return;
    }

    const { id, type, path } = Object.assign({ path: [] }, event.data);
    const args = (event.data.argumentList || []).map(fromWireValue);

    let returnValue;
    try {
      // Walk the property path to find the parent and the target
      const parent = path.slice(0, -1).reduce((obj, key) => obj[key], obj);
      const target = path.reduce((obj, key) => obj[key], obj);

      switch (type) {
        case "GET":
          // Read a property
          returnValue = target;
          break;

        case "SET":
          // Write a property
          parent[path.slice(-1)[0]] = fromWireValue(event.data.value);
          returnValue = true;
          break;

        case "APPLY":
          // Call a function
          returnValue = target.apply(parent, args);
          break;

        case "CONSTRUCT": {
          // new target(...args)
          const instance = new target(...args);
          returnValue = proxyValue(instance);   // return as a proxy
          break;
        }

        case "ENDPOINT": {
          // Create a new MessageChannel pair for a sub-endpoint
          const { port1, port2 } = new MessageChannel();
          expose(obj, port2);
          returnValue = transferMarked(port1, [port1]);
          break;
        }

        case "RELEASE":
          // Nothing to do on the exposed side
          returnValue = undefined;
          break;

        default:
          return;
      }
    } catch (err) {
      returnValue = { value: err, [COMLINK_THROWN]: 0 };
    }

    // Resolve the return value (may be a Promise) then send it back
    Promise.resolve(returnValue)
      .catch((err) => ({ value: err, [COMLINK_THROWN]: 0 }))
      .then((result) => {
        const [wireValue, transferables] = toWireValue(result);
        endpoint.postMessage(
          Object.assign(Object.assign({}, wireValue), { id }),
          transferables
        );

        // After RELEASE, clean up the listener and close the port
        if (type === "RELEASE") {
          endpoint.removeEventListener("message", handler);
          closeEndpoint(endpoint);
          if (COMLINK_FINALIZER in obj && typeof obj[COMLINK_FINALIZER] === "function") {
            obj[COMLINK_FINALIZER]();
          }
        }
      })
      .catch((err) => {
        // Return value could not be serialised — send a typed error instead
        const [wireValue, transferables] = toWireValue({
          value: new TypeError("Unserializable return value"),
          [COMLINK_THROWN]: 0,
        });
        endpoint.postMessage(
          Object.assign(Object.assign({}, wireValue), { id }),
          transferables
        );
      });
  });

  // Start the port if needed (MessagePort requires an explicit start)
  if (endpoint.start) endpoint.start();
}

// ── Helpers ────────────────────────────────────────────────

/** Returns true when `endpoint` is a MessagePort (needs explicit close). */
function isMessagePort(endpoint) {
  return endpoint.constructor.name === "MessagePort";
}

/** Closes a MessagePort (no-op for other endpoint types). */
function closeEndpoint(endpoint) {
  if (isMessagePort(endpoint)) endpoint.close();
}

// ── createProxy() – a Proxy that forwards calls via RPC ───

/**
 * Create a transparent Proxy that represents a remote object.
 * All property accesses, calls, and constructions are serialised and
 * sent over `endpoint`.
 *
 * @param {object} endpoint     - The MessagePort to talk through
 * @param {Map}    [callbacks]  - Pending promise callbacks, keyed by id
 * @param {Array}  [path]       - Current property path segments
 * @param {*}      [target]     - Proxy target (unused function by default)
 */
function createProxy(endpoint, callbacks) {
  // Build a one-shot listener that dispatches incoming responses by id
  const pendingCallbacks = new Map();
  endpoint.addEventListener("message", function (event) {
    const { data } = event;
    if (!data || !data.id) return;
    const resolve = pendingCallbacks.get(data.id);
    if (resolve) {
      try {
        resolve(data);
      } finally {
        pendingCallbacks.delete(data.id);
      }
    }
  });
  return buildProxy(endpoint, pendingCallbacks, [], function () {});
}

/** Throw an error if the proxy has already been released. */
function assertProxyAlive(released) {
  if (released) throw new Error("Proxy has been released and is not useable");
}

/** Release a proxy: send a RELEASE message and close the endpoint. */
function releaseProxy(endpoint) {
  return sendMessage(endpoint, new Map(), { type: "RELEASE" }).then(() => {
    closeEndpoint(endpoint);
  });
}

// ── FinalizationRegistry for automatic proxy cleanup ──────

const endpointReferenceCount = new WeakMap();

/**
 * FinalizationRegistry (if available) so that proxies are released when
 * they are GC-ed, preventing resource leaks.
 */
const finalizationRegistry =
  "FinalizationRegistry" in globalThis &&
  new FinalizationRegistry((endpoint) => {
    const count = (endpointReferenceCount.get(endpoint) || 0) - 1;
    endpointReferenceCount.set(endpoint, count);
    if (count === 0) releaseProxy(endpoint);
  });

/** Register `proxy` so the registry can clean up `endpoint` when GC-ed. */
function registerProxyForFinalization(proxy, endpoint) {
  const count = (endpointReferenceCount.get(endpoint) || 0) + 1;
  endpointReferenceCount.set(endpoint, count);
  if (finalizationRegistry) finalizationRegistry.register(proxy, endpoint, proxy);
}

/** Unregister `proxy` from the finalization registry. */
function unregisterProxy(proxy) {
  if (finalizationRegistry) finalizationRegistry.unregister(proxy);
}

/**
 * Build the actual ES Proxy object.
 * `path` accumulates property-name segments so that `proxy.a.b.c()` sends
 * { type:"APPLY", path:["a","b","c"] } over the wire.
 */
function buildProxy(endpoint, callbacks, path = [], target = function () {}) {
  let released = false;

  const proxy = new Proxy(target, {
    // ── Property GET ──────────────────────────────────────
    get(_, key) {
      assertProxyAlive(released);

      // Handle the release symbol
      if (key === COMLINK_RELEASE) {
        return () => {
          unregisterProxy(proxy);
          releaseProxy(endpoint);
          callbacks.clear();
          released = true;
        };
      }

      // Support .then() so the proxy can be used in await expressions
      if (key === "then") {
        if (path.length === 0) return { then: () => proxy };
        const promise = sendMessage(endpoint, callbacks, {
          type: "GET",
          path: path.map((seg) => seg.toString()),
        }).then(fromWireValue);
        return promise.then.bind(promise);
      }

      // Return a new proxy with the key appended to the path
      return buildProxy(endpoint, callbacks, [...path, key]);
    },

    // ── Property SET ──────────────────────────────────────
    set(_, key, value) {
      assertProxyAlive(released);
      const [wireValue, transferables] = toWireValue(value);
      return sendMessage(
        endpoint,
        callbacks,
        {
          type:  "SET",
          path:  [...path, key].map((seg) => seg.toString()),
          value: wireValue,
        },
        transferables
      ).then(fromWireValue);
    },

    // ── Function APPLY ────────────────────────────────────
    apply(_, _thisArg, args) {
      assertProxyAlive(released);
      const lastKey = path[path.length - 1];

      // Special case: .endpoint() returns a raw MessagePort for this object
      if (lastKey === COMLINK_ENDPOINT) {
        return sendMessage(endpoint, callbacks, { type: "ENDPOINT" }).then(fromWireValue);
      }

      // Special case: .bind() just strips the last segment (the "bind" key)
      if (lastKey === "bind") {
        return buildProxy(endpoint, callbacks, path.slice(0, -1));
      }

      // Normal function call
      const [wireArgs, transferables] = serializeArgs(args);
      return sendMessage(
        endpoint,
        callbacks,
        {
          type:         "APPLY",
          path:         path.map((seg) => seg.toString()),
          argumentList: wireArgs,
        },
        transferables
      ).then(fromWireValue);
    },

    // ── Constructor CONSTRUCT ─────────────────────────────
    construct(_, args) {
      assertProxyAlive(released);
      const [wireArgs, transferables] = serializeArgs(args);
      return sendMessage(
        endpoint,
        callbacks,
        {
          type:         "CONSTRUCT",
          path:         path.map((seg) => seg.toString()),
          argumentList: wireArgs,
        },
        transferables
      ).then(fromWireValue);
    },
  });

  registerProxyForFinalization(proxy, endpoint);
  return proxy;
}

// ── Wire-value helpers ─────────────────────────────────────

/** Flatten nested arrays of transferables into a single flat array. */
function flattenTransferables(arr) {
  return Array.prototype.concat.apply([], arr);
}

/**
 * Convert an argument list to a parallel pair:
 *   [wireValues[], transferables[]]
 */
function serializeArgs(args) {
  const pairs = args.map(toWireValue);
  return [
    pairs.map((p) => p[0]),
    flattenTransferables(pairs.map((p) => p[1])),
  ];
}

/** WeakMap from endpoint → array of transferables that should travel with it */
const endpointTransferables = new WeakMap();

/** Tag `endpoint` with a list of transferable objects. */
function transferMarked(endpoint, transferables) {
  endpointTransferables.set(endpoint, transferables);
  return endpoint;
}

/** Mark `obj` as a Comlink proxy (adds the COMLINK_PROXY symbol). */
function proxyValue(obj) {
  return Object.assign(obj, { [COMLINK_PROXY]: true });
}

/**
 * Serialise `value` to a "wire value" descriptor plus a list of
 * transferable objects.
 */
function toWireValue(value) {
  // Try each registered transfer handler first
  for (const [name, handler] of transferHandlers) {
    if (handler.canHandle(value)) {
      const [serialised, transferables] = handler.serialize(value);
      return [{ type: "HANDLER", name, value: serialised }, transferables];
    }
  }
  // Fall back to plain ("RAW") transfer
  return [{ type: "RAW", value }, endpointTransferables.get(value) || []];
}

/**
 * Deserialise a wire value descriptor back to a JS value.
 * Dispatches to the appropriate handler or returns the raw value.
 */
function fromWireValue(wireValue) {
  switch (wireValue.type) {
    case "HANDLER":
      return transferHandlers.get(wireValue.name).deserialize(wireValue.value);
    case "RAW":
      return wireValue.value;
  }
}

/**
 * Send a single message over `endpoint` and return a Promise that resolves
 * with the response (matched by a random id).
 */
function sendMessage(endpoint, callbacks, message, transferables) {
  return new Promise((resolve) => {
    const id = generateId();
    callbacks.set(id, resolve);
    if (endpoint.start) endpoint.start();
    endpoint.postMessage(Object.assign({ id }, message), transferables);
  });
}

/**
 * Generate a random 64-bit hex string used as a message correlation id.
 * Format: four 13-hex-char segments joined with "-".
 */
function generateId() {
  return new Array(4)
    .fill(0)
    .map(() => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16))
    .join("-");
}

// ============================================================
// SECTION 2 – ORE / PLATFORM IMAGES (base64-encoded WebP)
// ============================================================
// These are small thumbnail images embedded inline to avoid extra network
// requests.  Each constant name corresponds to an ore type.

/** Diamond ore thumbnail */
const IMG_DIAMOND      = "data:image/webp;base64,UklGRnQIAABXRUJQ..."; // (truncated for readability)

/** Ancient Debris thumbnail */
const IMG_ANCIENT_DEBRIS = "data:image/webp;base64,UklGRroHAABXRUJQ...";

/** Redstone ore thumbnail */
const IMG_REDSTONE     = "data:image/webp;base64,UklGRu4IAABOX...";

/** Iron ore thumbnail */
const IMG_IRON         = "data:image/webp;base64,UklGRtgFAABXRUJQ...";

/** Emerald ore thumbnail */
const IMG_EMERALD      = "data:image/webp;base64,UklGRuIHAABXRUJQ...";

/** Gold ore thumbnail */
const IMG_GOLD         = "data:image/webp;base64,UklGRhQIAABXRUJQ...";

/** Lapis Lazuli ore thumbnail */
const IMG_LAPIS        = "data:image/webp;base64,UklGRnoIAABXRUJQ...";

/** Coal ore thumbnail */
const IMG_COAL         = "data:image/webp;base64,UklGRg4GAABOX...";

/** Copper ore thumbnail */
const IMG_COPPER       = "data:image/webp;base64,UklGRkgGAABXRUJQ...";

// ============================================================
// SECTION 3 – CONSTANTS & ORE METADATA
// ============================================================

/** Confidence levels returned by the WASM finder */
const Confidence = {
  LOW:     "LOW",
  DEFAULT: "DEFAULT",
};

/** Minecraft edition identifiers */
const Edition = {
  Java:    1,
  Bedrock: 2,
};

/**
 * Numeric version codes.  Encoded as MAJOR*10000 + MINOR*10 (+patch for
 * editions that diverged mid-version, e.g. Java 1.20.2 vs Bedrock 1.20.30).
 */
const Version = {
  V1_17:              10170,
  V1_18:              10180,
  V1_19:              10190,
  V1_20:              10200,
  V1_20_2_Java:       10202,
  V1_20_30_Bedrock:   10203,
  V1_21:              10210,
};

/** Ore type identifiers (numeric enum passed to the WASM back-end). */
const OreType = {
  DIAMONDS:       1,
  ANCIENT_DEBRIS: 2,
  REDSTONE:       3,
  IRON:           4,
  EMERALD:        5,
  GOLD:           6,
  LAPIS:          7,
  COAL:           8,
  COPPER:         9,
};

/**
 * All supported platform/version combinations.
 * Each key is a human-readable platform string used as the `platform`
 * argument of `findOres`.
 */
const platforms = {
  bedrock_1_17:  { edition: Edition.Bedrock, version: Version.V1_17,            label: "Bedrock 1.17" },
  bedrock_1_18:  { edition: Edition.Bedrock, version: Version.V1_18,            label: "Bedrock 1.18" },
  bedrock_1_19:  { edition: Edition.Bedrock, version: Version.V1_19,            label: "Bedrock 1.19" },
  bedrock_1_20:  { edition: Edition.Bedrock, version: Version.V1_20,            label: "Bedrock 1.20" },
  bedrock_1_20_30: { edition: Edition.Bedrock, version: Version.V1_20_30_Bedrock, label: "Bedrock 1.20.30" },
  bedrock_1_21:  { edition: Edition.Bedrock, version: Version.V1_21,            label: "Bedrock 1.21" },
  java_1_17:     { edition: Edition.Java,    version: Version.V1_17,            label: "Java 1.17" },
  java_1_18:     { edition: Edition.Java,    version: Version.V1_18,            label: "Java 1.18" },
  java_1_19:     { edition: Edition.Java,    version: Version.V1_19,            label: "Java 1.19" },
  java_1_20:     { edition: Edition.Java,    version: Version.V1_20,            label: "Java 1.20" },
  java_1_20_2:   { edition: Edition.Java,    version: Version.V1_20_2_Java,     label: "Java 1.20.2" },
  java_1_21:     { edition: Edition.Java,    version: Version.V1_21,            label: "Java 1.21" },
};

/**
 * Per-ore configuration objects.
 *
 * Each entry exposes:
 *   label            – human-readable name
 *   oreType          – OreType enum value
 *   isSupported(p)   – returns true if the platform key supports this ore
 *   getSize(c, p)    – "small" | "medium" | "big" based on estimated count
 *   getEstimatedCount(c, p) – { count, isExact }
 *   img              – embedded thumbnail images
 *   getSearchRadius(filter) – chunk search radius hint
 */
const ores = {

  // ── Ancient Debris ──────────────────────────────────────
  ancient_debris: {
    label:       "Ancient Debris",
    oreType:     OreType.ANCIENT_DEBRIS,
    isSupported: (_platform) => true,   // available in all versions

    getSize(cluster, platform) {
      const count = ores.ancient_debris.getEstimatedCount(cluster, platform).count;
      return count <= 1 ? "small" : count <= 2 ? "medium" : "big";
    },

    getEstimatedCount(cluster, _platform) {
      // If the WASM returned an exact ore count, use it; otherwise estimate
      // from the internal vein-size field (debris veins contain 3 "extra" blocks)
      if (cluster.ores != null) return { count: cluster.ores, isExact: true };
      return { count: cluster.internalSize - 3, isExact: false };
    },

    img: { s40: IMG_ANCIENT_DEBRIS },

    getSearchRadius: (filter) => ({ big: 5, medium: 4, all: 3 })[filter],
  },

  // ── Diamond ─────────────────────────────────────────────
  diamond: {
    label:       "Diamond",
    oreType:     OreType.DIAMONDS,
    isSupported: (_platform) => true,

    getSize(cluster, platform) {
      const count = ores.diamond.getEstimatedCount(cluster, platform).count;
      return count <= 3 ? "small" : count <= 7 ? "medium" : "big";
    },

    getEstimatedCount(cluster, _platform) {
      if (cluster.ores != null) return { count: cluster.ores, isExact: true };
      // Diamond veins include 2 non-ore blocks in the internal size
      return { count: cluster.internalSize - 2, isExact: false };
    },

    img: { s40: IMG_DIAMOND },
    getSearchRadius: () => 3,
  },

  // ── Redstone ─────────────────────────────────────────────
  redstone: {
    label:       "Redstone",
    oreType:     OreType.REDSTONE,
    isSupported: (platform) => platforms[platform].version >= Version.V1_18,

    getSize(cluster, platform) {
      const count = ores.redstone.getEstimatedCount(cluster, platform).count;
      return count <= 4 ? "small" : count <= 7 ? "medium" : "big";
    },

    getEstimatedCount(cluster, _platform) {
      if (cluster.ores != null) return { count: cluster.ores, isExact: true };
      return { count: cluster.internalSize - 3, isExact: false };
    },

    img: { s40: IMG_REDSTONE },
    getSearchRadius: () => 3,
  },

  // ── Iron ─────────────────────────────────────────────────
  iron: {
    label:       "Iron",
    oreType:     OreType.IRON,
    isSupported: (platform) => platforms[platform].version >= Version.V1_18,

    getSize(cluster, platform) {
      const count = ores.iron.getEstimatedCount(cluster, platform).count;
      // Bedrock has larger natural iron veins → higher thresholds
      if (platforms[platform].edition >= Edition.Bedrock) {
        return count < 7 ? "small" : count < 10 ? "medium" : "big";
      }
      return count < 5 ? "small" : count < 8 ? "medium" : "big";
    },

    getEstimatedCount(cluster, _platform) {
      if (cluster.ores == null) throw new Error("Invalid cluster");
      return { count: cluster.ores, isExact: true };
    },

    img: { s40: IMG_IRON },
    getSearchRadius: () => 1,
  },

  // ── Gold ─────────────────────────────────────────────────
  gold: {
    label:       "Gold",
    oreType:     OreType.GOLD,
    isSupported: (platform) => platforms[platform].version >= Version.V1_18,

    getSize(cluster, platform) {
      const count = ores.gold.getEstimatedCount(cluster, platform).count;
      return count < 6 ? "small" : count < 9 ? "medium" : "big";
    },

    getEstimatedCount(cluster, platform) {
      if (cluster.ores == null) throw new Error("Invalid cluster");
      // On Bedrock, gold counts are estimates (vein structure differs)
      return { count: cluster.ores, isExact: platforms[platform].edition !== Edition.Bedrock };
    },

    img: { s40: IMG_GOLD },
    getSearchRadius: () => 2,
  },

  // ── Emerald ──────────────────────────────────────────────
  emerald: {
    label:       "Emerald",
    oreType:     OreType.EMERALD,
    // Emeralds only exist in mountain biomes starting Java 1.18
    isSupported: (platform) =>
      platforms[platform].edition === Edition.Java &&
      platforms[platform].version >= Version.V1_18,

    getSize(cluster, platform) {
      return ores.emerald.getEstimatedCount(cluster, platform).count < 2 ? "small" : "big";
    },

    getEstimatedCount(cluster, _platform) {
      if (cluster.ores == null) throw new Error("Invalid cluster");
      return { count: cluster.ores, isExact: true };
    },

    img: { s40: IMG_EMERALD },
    getSearchRadius: () => 5,
  },

  // ── Lapis Lazuli ─────────────────────────────────────────
  lapis: {
    label:       "Lapis Lazuli",
    oreType:     OreType.LAPIS,
    isSupported: (platform) => platforms[platform].version >= Version.V1_18,

    getSize(cluster, platform) {
      const count = ores.lapis.getEstimatedCount(cluster, platform).count;
      return count < 5 ? "small" : count < 7 ? "medium" : "big";
    },

    getEstimatedCount(cluster, _platform) {
      if (cluster.ores == null) throw new Error("Invalid cluster");
      return { count: cluster.ores, isExact: true };
    },

    img: { s40: IMG_LAPIS },
    getSearchRadius: () => 2,
  },

  // ── Coal ─────────────────────────────────────────────────
  coal: {
    label:       "Coal",
    oreType:     OreType.COAL,
    isSupported: (platform) => platforms[platform].version >= Version.V1_18,

    getSize(cluster, platform) {
      // All Bedrock coal clusters are considered "big" (veins are large)
      if (platforms[platform].edition === Edition.Bedrock) return "big";
      const count = ores.coal.getEstimatedCount(cluster, platform).count;
      return count < 18 ? "small" : count < 25 ? "medium" : "big";
    },

    getEstimatedCount(cluster, _platform) {
      // Use a default estimate of 20 when no exact count is available
      if (cluster.ores == null) return { count: 20, isExact: false };
      return { count: cluster.ores, isExact: true };
    },

    img: { s40: IMG_COAL },
    getSearchRadius: () => 1,
  },

  // ── Copper ───────────────────────────────────────────────
  copper: {
    label:       "Copper",
    oreType:     OreType.COPPER,
    isSupported: (platform) => platforms[platform].version >= Version.V1_18,

    getSize(cluster, platform) {
      const count = ores.copper.getEstimatedCount(cluster, platform).count;
      return count < 7 ? "small" : count < 25 ? "medium" : "big";
    },

    getEstimatedCount(cluster, _platform) {
      if (cluster.ores == null) {
        // Two common vein sizes used internally: 10 → ~8 ores, 20 → ~30 ores
        if (cluster.internalSize === 10) return { count: 8,  isExact: false };
        if (cluster.internalSize === 20) return { count: 30, isExact: false };
        throw new Error("Unknown copper cluster size");
      }
      return { count: cluster.ores, isExact: true };
    },

    img: { s40: IMG_COPPER },
    getSearchRadius: () => 1,
  },
};

// ============================================================
// SECTION 4 – LONG.JS  (64-bit integer support)
// ============================================================
/**
 * @license
 * Copyright 2009 The Closure Library Authors
 * Copyright 2020 Daniel Wirtz / The long.js Authors.
 * Licensed under the Apache License, Version 2.0
 * SPDX-License-Identifier: Apache-2.0
 *
 * Long.js provides JavaScript with 64-bit integer arithmetic.
 * Minecraft world seeds are 64-bit signed integers, so this library is
 * required to represent and pass them to the WASM module correctly.
 */

// ── Optional WebAssembly accelerator for 64-bit math ──────

/**
 * If the browser supports WebAssembly we load a tiny WASM module that
 * accelerates 64-bit multiply / divide / modulo via native i64 instructions.
 * Falls back gracefully to pure-JS if WASM is unavailable.
 */
let wasmMath = null;
try {
  wasmMath = new WebAssembly.Instance(
    new WebAssembly.Module(
      // Binary encoding of a minimal WASM module that exports:
      //   mul(lo_a, hi_a, lo_b, hi_b) → lo result  (hi via get_high)
      //   div_s / div_u / rem_s / rem_u – signed/unsigned divide & remainder
      //   get_high() → high 32 bits of last 64-bit result
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, /* WASM magic + version */
        /* ... (binary omitted for readability) ... */
      ])
    ),
    {}
  ).exports;
} catch (_) {
  // WASM unavailable – pure-JS fallback will be used
}

// ── Long constructor ───────────────────────────────────────

/**
 * Represents a 64-bit integer as two 32-bit halves.
 *
 * @param {number}  low      - Lower 32 bits (signed or unsigned)
 * @param {number}  high     - Upper 32 bits (signed or unsigned)
 * @param {boolean} unsigned - True for unsigned, false for signed (default)
 */
function Long(low, high, unsigned) {
  this.low     = low  | 0;
  this.high    = high | 0;
  this.unsigned = !!unsigned;
}

Long.prototype.__isLong__;
Object.defineProperty(Long.prototype, "__isLong__", { value: true });

/** Type-guard: returns true when `val` is a Long instance. */
function isLong(val) {
  return (val && val.__isLong__) === true;
}

/** Count trailing zeros in a 32-bit integer. */
function ctz32(value) {
  const trailingZeros = Math.clz32(value & -value);
  return value ? 31 - trailingZeros : trailingZeros;
}

Long.isLong = isLong;

/** Cache for small signed integers [-128, 127] */
const INT_CACHE  = {};
/** Cache for small unsigned integers [0, 255] */
const UINT_CACHE = {};

/**
 * Convert a 32-bit JavaScript number to a Long.
 * Uses caches for frequently used small values.
 *
 * @param {number}  value
 * @param {boolean} [unsigned=false]
 */
function fromInt(value, unsigned) {
  let obj, cachedObj, cache;
  if (unsigned) {
    value >>>= 0;
    if ((cache = 0 <= value && value < 256)) {
      cachedObj = UINT_CACHE[value];
      if (cachedObj) return cachedObj;
    }
    obj = fromBits(value, 0, true);
    if (cache) UINT_CACHE[value] = obj;
    return obj;
  } else {
    value |= 0;
    if ((cache = -128 <= value && value < 128)) {
      cachedObj = INT_CACHE[value];
      if (cachedObj) return cachedObj;
    }
    obj = fromBits(value, value < 0 ? -1 : 0, false);
    if (cache) INT_CACHE[value] = obj;
    return obj;
  }
}
Long.fromInt = fromInt;

/** Power helper */
const pow2 = Math.pow;

/** Frequently used constants */
const TWO_PWR_16_DBL   = 65536;
const TWO_PWR_24_DBL   = 1 << 24;
const TWO_PWR_32_DBL   = TWO_PWR_16_DBL * TWO_PWR_16_DBL;
const TWO_PWR_64_DBL   = TWO_PWR_32_DBL * TWO_PWR_32_DBL;
const TWO_PWR_63_DBL   = TWO_PWR_64_DBL / 2;
const TWO_PWR_24       = fromInt(TWO_PWR_24_DBL);
const ZERO             = fromInt(0);
Long.ZERO              = ZERO;
const UZERO            = fromInt(0, true);
Long.UZERO             = UZERO;
const ONE              = fromInt(1);
Long.ONE               = ONE;
const UONE             = fromInt(1, true);
Long.UONE              = UONE;
const NEG_ONE          = fromInt(-1);
Long.NEG_ONE           = NEG_ONE;
const MAX_VALUE        = fromBits(-1, 2147483647,  false);  //  2^63 - 1
Long.MAX_VALUE         = MAX_VALUE;
const MAX_UNSIGNED_VALUE = fromBits(-1, -1, true);           //  2^64 - 1
Long.MAX_UNSIGNED_VALUE  = MAX_UNSIGNED_VALUE;
const MIN_VALUE        = fromBits(0, -2147483648,  false);  // -2^63
Long.MIN_VALUE         = MIN_VALUE;

/**
 * Create a Long from a floating-point number.
 * Handles the full signed/unsigned 64-bit range.
 */
function fromNumber(value, unsigned) {
  if (isNaN(value)) return unsigned ? UZERO : ZERO;
  if (unsigned) {
    if (value < 0)              return UZERO;
    if (value >= TWO_PWR_64_DBL) return MAX_UNSIGNED_VALUE;
  } else {
    if (value <= -TWO_PWR_63_DBL) return MIN_VALUE;
    if (value + 1 >= TWO_PWR_63_DBL) return MAX_VALUE;
  }
  if (value < 0) return fromNumber(-value, unsigned).neg();
  return fromBits(
    (value % TWO_PWR_32_DBL) | 0,
    (value / TWO_PWR_32_DBL) | 0,
    unsigned
  );
}
Long.fromNumber = fromNumber;

/** Construct a Long directly from its two 32-bit halves. */
function fromBits(low, high, unsigned) {
  return new Long(low, high, unsigned);
}
Long.fromBits = fromBits;

/**
 * Parse a Long from a string in the given radix (default 10).
 * Handles negative numbers (leading "-") and arbitrary bases 2–36.
 */
function fromString(str, unsigned, radix) {
  if (str.length === 0) throw Error("empty string");
  if (typeof unsigned === "number") {
    radix    = unsigned;
    unsigned = false;
  } else {
    unsigned = !!unsigned;
  }

  if (["NaN", "Infinity", "+Infinity", "-Infinity"].includes(str)) {
    return unsigned ? UZERO : ZERO;
  }

  radix = radix || 10;
  if (radix < 2 || 36 < radix) throw RangeError("radix");

  let index;
  if ((index = str.indexOf("-")) > 0) throw Error("interior hyphen");
  if (index === 0) return fromString(str.substring(1), unsigned, radix).neg();

  // Process the string in 8-character chunks
  const radixToPower = fromNumber(pow2(radix, 8));
  let result = ZERO;
  for (let i = 0; i < str.length; i += 8) {
    const size   = Math.min(8, str.length - i);
    const value  = parseInt(str.substring(i, i + size), radix);
    if (size < 8) {
      const power = fromNumber(pow2(radix, size));
      result = result.mul(power).add(fromNumber(value));
    } else {
      result = result.mul(radixToPower);
      result = result.add(fromNumber(value));
    }
  }
  result.unsigned = unsigned;
  return result;
}
Long.fromString = fromString;

/**
 * Universal constructor: accepts number, string, or Long.
 *
 * @param {number|string|Long} val
 * @param {boolean} [unsigned]
 */
function fromValue(val, unsigned) {
  if (typeof val === "number") return fromNumber(val, unsigned);
  if (typeof val === "string") return fromString(val, unsigned);
  // Assume Long-like object
  return fromBits(
    val.low,
    val.high,
    typeof unsigned === "boolean" ? unsigned : val.unsigned
  );
}
Long.fromValue = fromValue;

// ── Long prototype methods ─────────────────────────────────

const LongProto = Long.prototype;

/** Convert to a 32-bit signed or unsigned JavaScript integer. */
LongProto.toInt = function () {
  return this.unsigned ? this.low >>> 0 : this.low;
};

/** Convert to a JavaScript float64 (may lose precision for very large values). */
LongProto.toNumber = function () {
  return this.unsigned
    ? (this.high >>> 0) * TWO_PWR_32_DBL + (this.low >>> 0)
    : this.high * TWO_PWR_32_DBL + (this.low >>> 0);
};

/** Convert to a string in the given radix (default decimal). */
LongProto.toString = function (radix) {
  radix = radix || 10;
  if (radix < 2 || 36 < radix) throw RangeError("radix");
  if (this.isZero()) return "0";
  if (this.isNegative()) {
    if (this.eq(MIN_VALUE)) {
      // Special case: MIN_VALUE.neg() overflows
      const radixLong = fromNumber(radix);
      const div       = this.div(radixLong);
      const rem       = div.mul(radixLong).sub(this);
      return div.toString(radix) + rem.toInt().toString(radix);
    }
    return "-" + this.neg().toString(radix);
  }
  // Build string from right using base^6 chunks
  const radixToPower = fromNumber(pow2(radix, 6), this.unsigned);
  let current = this;
  let result  = "";
  while (true) {
    const rem    = current.div(radixToPower);
    const intVal = current.sub(rem.mul(radixToPower)).toInt() >>> 0;
    let digits   = intVal.toString(radix);
    current      = rem;
    if (current.isZero()) return digits + result;
    while (digits.length < 6) digits = "0" + digits;
    result = "" + digits + result;
  }
};

/** Return the high 32 bits as a signed integer. */
LongProto.getHighBits = function () { return this.high; };
/** Return the high 32 bits as an unsigned integer. */
LongProto.getHighBitsUnsigned = function () { return this.high >>> 0; };
/** Return the low 32 bits as a signed integer. */
LongProto.getLowBits = function () { return this.low; };
/** Return the low 32 bits as an unsigned integer. */
LongProto.getLowBitsUnsigned = function () { return this.low >>> 0; };

/** Return the number of bits needed to represent the absolute value. */
LongProto.getNumBitsAbs = function () {
  if (this.isNegative()) {
    return this.eq(MIN_VALUE) ? 64 : this.neg().getNumBitsAbs();
  }
  const val = this.high !== 0 ? this.high : this.low;
  let bit = 31;
  while (bit > 0 && (val & (1 << bit)) === 0) bit--;
  return this.high !== 0 ? bit + 33 : bit + 1;
};

/** Return true if this value is safe to represent as a JS integer. */
LongProto.isSafeInteger = function () {
  const sign = this.high >> 21;
  if (sign) {
    return this.unsigned ? false : sign === -1 && !(this.low === 0 && this.high === -2097152);
  }
  return true;
};

LongProto.isZero    = function () { return this.high === 0 && this.low === 0; };
LongProto.eqz      = LongProto.isZero;
LongProto.isNegative = function () { return !this.unsigned && this.high < 0; };
LongProto.isPositive = function () { return this.unsigned || this.high >= 0; };
LongProto.isOdd   = function () { return (this.low & 1) === 1; };
LongProto.isEven  = function () { return (this.low & 1) === 0; };

LongProto.equals = function (other) {
  if (!isLong(other)) other = fromValue(other);
  // Different signedness with high bit set → treat as different values
  if (this.unsigned !== other.unsigned && this.high >>> 31 === 1 && other.high >>> 31 === 1)
    return false;
  return this.high === other.high && this.low === other.low;
};
LongProto.eq = LongProto.equals;

LongProto.notEquals = function (other) { return !this.eq(other); };
LongProto.neq = LongProto.notEquals;
LongProto.ne  = LongProto.notEquals;

LongProto.lessThan          = function (other) { return this.comp(other) < 0; };
LongProto.lt                = LongProto.lessThan;
LongProto.lessThanOrEqual   = function (other) { return this.comp(other) <= 0; };
LongProto.lte               = LongProto.lessThanOrEqual;
LongProto.le                = LongProto.lessThanOrEqual;
LongProto.greaterThan       = function (other) { return this.comp(other) > 0; };
LongProto.gt                = LongProto.greaterThan;
LongProto.greaterThanOrEqual = function (other) { return this.comp(other) >= 0; };
LongProto.gte               = LongProto.greaterThanOrEqual;
LongProto.ge                = LongProto.greaterThanOrEqual;

LongProto.compare = function (other) {
  if (!isLong(other)) other = fromValue(other);
  if (this.eq(other)) return 0;
  const thisNeg  = this.isNegative();
  const otherNeg = other.isNegative();
  if (thisNeg && !otherNeg) return -1;
  if (!thisNeg && otherNeg) return  1;
  if (this.unsigned) {
    return (other.high >>> 0 > this.high >>> 0) ||
           (other.high === this.high && other.low >>> 0 > this.low >>> 0)
      ? -1 : 1;
  }
  return this.sub(other).isNegative() ? -1 : 1;
};
LongProto.comp = LongProto.compare;

LongProto.negate = function () {
  return !this.unsigned && this.eq(MIN_VALUE) ? MIN_VALUE : this.not().add(ONE);
};
LongProto.neg = LongProto.negate;

LongProto.add = function (addend) {
  if (!isLong(addend)) addend = fromValue(addend);
  // Split each value into four 16-bit chunks and add with carry
  const a48 = this.high >>> 16,  a32 = this.high & 0xFFFF;
  const a16 = this.low  >>> 16,  a00 = this.low  & 0xFFFF;
  const b48 = addend.high >>> 16, b32 = addend.high & 0xFFFF;
  const b16 = addend.low  >>> 16, b00 = addend.low  & 0xFFFF;
  let c48 = 0, c32 = 0, c16 = 0, c00 = 0;
  c00 += a00 + b00; c16 += c00 >>> 16; c00 &= 0xFFFF;
  c16 += a16 + b16; c32 += c16 >>> 16; c16 &= 0xFFFF;
  c32 += a32 + b32; c48 += c32 >>> 16; c32 &= 0xFFFF;
  c48 += a48 + b48; c48 &= 0xFFFF;
  return fromBits((c16 << 16) | c00, (c48 << 16) | c32, this.unsigned);
};

LongProto.subtract = function (subtrahend) {
  if (!isLong(subtrahend)) subtrahend = fromValue(subtrahend);
  return this.add(subtrahend.neg());
};
LongProto.sub = LongProto.subtract;

LongProto.multiply = function (multiplier) {
  if (this.isZero()) return this;
  if (!isLong(multiplier)) multiplier = fromValue(multiplier);

  // Use WASM accelerator if available
  if (wasmMath) {
    const lo = wasmMath.mul(this.low, this.high, multiplier.low, multiplier.high);
    return fromBits(lo, wasmMath.get_high(), this.unsigned);
  }

  if (multiplier.isZero()) return this.unsigned ? UZERO : ZERO;
  if (this.eq(MIN_VALUE))  return multiplier.isOdd() ? MIN_VALUE : ZERO;
  if (multiplier.eq(MIN_VALUE)) return this.isOdd() ? MIN_VALUE : ZERO;

  // Handle negative operands
  if (this.isNegative()) {
    if (multiplier.isNegative()) return this.neg().mul(multiplier.neg());
    return this.neg().mul(multiplier).neg();
  }
  if (multiplier.isNegative()) return this.mul(multiplier.neg()).neg();

  // Small numbers: use native float multiply
  if (this.lt(TWO_PWR_24) && multiplier.lt(TWO_PWR_24)) {
    return fromNumber(this.toNumber() * multiplier.toNumber(), this.unsigned);
  }

  // Full 64-bit multiply using 16-bit chunks
  const a48 = this.high >>> 16,         a32 = this.high & 0xFFFF;
  const a16 = this.low  >>> 16,         a00 = this.low  & 0xFFFF;
  const b48 = multiplier.high >>> 16,   b32 = multiplier.high & 0xFFFF;
  const b16 = multiplier.low  >>> 16,   b00 = multiplier.low  & 0xFFFF;
  let c48 = 0, c32 = 0, c16 = 0, c00 = 0;
  c00 += a00 * b00; c16 += c00 >>> 16; c00 &= 0xFFFF;
  c16 += a16 * b00; c32 += c16 >>> 16; c16 &= 0xFFFF;
  c16 += a00 * b16; c32 += c16 >>> 16; c16 &= 0xFFFF;
  c32 += a32 * b00; c48 += c32 >>> 16; c32 &= 0xFFFF;
  c32 += a16 * b16; c48 += c32 >>> 16; c32 &= 0xFFFF;
  c32 += a00 * b32; c48 += c32 >>> 16; c32 &= 0xFFFF;
  c48 += a48 * b00 + a32 * b16 + a16 * b32 + a00 * b48; c48 &= 0xFFFF;
  return fromBits((c16 << 16) | c00, (c48 << 16) | c32, this.unsigned);
};
LongProto.mul = LongProto.multiply;

LongProto.divide = function (divisor) {
  if (!isLong(divisor)) divisor = fromValue(divisor);
  if (divisor.isZero()) throw Error("division by zero");

  if (wasmMath) {
    if (!this.unsigned && this.high === -2147483648 && divisor.low === -1 && divisor.high === -1)
      return this; // overflow edge case
    const lo = (this.unsigned ? wasmMath.div_u : wasmMath.div_s)(
      this.low, this.high, divisor.low, divisor.high
    );
    return fromBits(lo, wasmMath.get_high(), this.unsigned);
  }

  if (this.isZero()) return this.unsigned ? UZERO : ZERO;

  let quotient, remainder, approx;
  if (this.unsigned) {
    if (!divisor.unsigned) divisor = divisor.toUnsigned();
    if (divisor.gt(this)) return UZERO;
    if (divisor.gt(this.shru(1))) return UONE;
    quotient = UZERO;
  } else {
    // Special case for MIN_VALUE
    if (this.eq(MIN_VALUE)) {
      if (divisor.eq(ONE) || divisor.eq(NEG_ONE)) return MIN_VALUE;
      if (divisor.eq(MIN_VALUE)) return ONE;
      // Shift down, divide, then adjust
      const halfThis = this.shr(1);
      approx = halfThis.div(divisor).shl(1);
      if (approx.eq(ZERO)) {
        return divisor.isNegative() ? ONE : NEG_ONE;
      }
      remainder = this.sub(divisor.mul(approx));
      quotient  = approx.add(remainder.div(divisor));
      return quotient;
    } else if (divisor.eq(MIN_VALUE)) {
      return this.unsigned ? UZERO : ZERO;
    }
    if (this.isNegative()) {
      if (divisor.isNegative()) return this.neg().div(divisor.neg());
      return this.neg().div(divisor).neg();
    }
    if (divisor.isNegative()) return this.div(divisor.neg()).neg();
    quotient = ZERO;
  }

  // Long division
  remainder = this;
  while (remainder.gte(divisor)) {
    approx = Math.max(1, Math.floor(remainder.toNumber() / divisor.toNumber()));
    const log2   = Math.ceil(Math.log(approx) / Math.LN2);
    const delta  = log2 <= 48 ? 1 : pow2(2, log2 - 48);
    let approxLong = fromNumber(approx);
    let product    = approxLong.mul(divisor);
    while (product.isNegative() || product.gt(remainder)) {
      approx    -= delta;
      approxLong = fromNumber(approx, this.unsigned);
      product    = approxLong.mul(divisor);
    }
    if (approxLong.isZero()) approxLong = ONE;
    quotient  = quotient.add(approxLong);
    remainder = remainder.sub(product);
  }
  return quotient;
};
LongProto.div = LongProto.divide;

LongProto.modulo = function (divisor) {
  if (!isLong(divisor)) divisor = fromValue(divisor);
  if (wasmMath) {
    const lo = (this.unsigned ? wasmMath.rem_u : wasmMath.rem_s)(
      this.low, this.high, divisor.low, divisor.high
    );
    return fromBits(lo, wasmMath.get_high(), this.unsigned);
  }
  return this.sub(this.div(divisor).mul(divisor));
};
LongProto.mod = LongProto.modulo;
LongProto.rem = LongProto.modulo;

LongProto.not = function () { return fromBits(~this.low, ~this.high, this.unsigned); };

LongProto.countLeadingZeros = function () {
  return this.high ? Math.clz32(this.high) : Math.clz32(this.low) + 32;
};
LongProto.clz = LongProto.countLeadingZeros;

LongProto.countTrailingZeros = function () {
  return this.low ? ctz32(this.low) : ctz32(this.high) + 32;
};
LongProto.ctz = LongProto.countTrailingZeros;

LongProto.and = function (other) {
  if (!isLong(other)) other = fromValue(other);
  return fromBits(this.low & other.low, this.high & other.high, this.unsigned);
};
LongProto.or = function (other) {
  if (!isLong(other)) other = fromValue(other);
  return fromBits(this.low | other.low, this.high | other.high, this.unsigned);
};
LongProto.xor = function (other) {
  if (!isLong(other)) other = fromValue(other);
  return fromBits(this.low ^ other.low, this.high ^ other.high, this.unsigned);
};

LongProto.shiftLeft = function (numBits) {
  if (isLong(numBits)) numBits = numBits.toInt();
  numBits &= 63;
  if (numBits === 0)      return this;
  if (numBits < 32)       return fromBits(this.low << numBits, (this.high << numBits) | (this.low >>> (32 - numBits)), this.unsigned);
  return fromBits(0, this.low << (numBits - 32), this.unsigned);
};
LongProto.shl = LongProto.shiftLeft;

LongProto.shiftRight = function (numBits) {
  if (isLong(numBits)) numBits = numBits.toInt();
  numBits &= 63;
  if (numBits === 0)  return this;
  if (numBits < 32)   return fromBits((this.low >>> numBits) | (this.high << (32 - numBits)), this.high >> numBits, this.unsigned);
  return fromBits(this.high >> (numBits - 32), this.high >= 0 ? 0 : -1, this.unsigned);
};
LongProto.shr = LongProto.shiftRight;

LongProto.shiftRightUnsigned = function (numBits) {
  if (isLong(numBits)) numBits = numBits.toInt();
  numBits &= 63;
  if (numBits === 0)   return this;
  if (numBits < 32)    return fromBits((this.low >>> numBits) | (this.high << (32 - numBits)), this.high >>> numBits, this.unsigned);
  if (numBits === 32)  return fromBits(this.high, 0, this.unsigned);
  return fromBits(this.high >>> (numBits - 32), 0, this.unsigned);
};
LongProto.shru  = LongProto.shiftRightUnsigned;
LongProto.shr_u = LongProto.shiftRightUnsigned;

LongProto.rotateLeft = function (numBits) {
  let n;
  if (isLong(numBits)) numBits = numBits.toInt();
  numBits &= 63;
  if (numBits === 0)   return this;
  if (numBits === 32)  return fromBits(this.high, this.low, this.unsigned);
  if (numBits < 32) {
    n = 32 - numBits;
    return fromBits((this.low << numBits) | (this.high >>> n), (this.high << numBits) | (this.low >>> n), this.unsigned);
  }
  numBits -= 32;
  n = 32 - numBits;
  return fromBits((this.high << numBits) | (this.low >>> n), (this.low << numBits) | (this.high >>> n), this.unsigned);
};
LongProto.rotl = LongProto.rotateLeft;

LongProto.rotateRight = function (numBits) {
  let n;
  if (isLong(numBits)) numBits = numBits.toInt();
  numBits &= 63;
  if (numBits === 0)   return this;
  if (numBits === 32)  return fromBits(this.high, this.low, this.unsigned);
  if (numBits < 32) {
    n = 32 - numBits;
    return fromBits((this.high << n) | (this.low >>> numBits), (this.low << n) | (this.high >>> numBits), this.unsigned);
  }
  numBits -= 32;
  n = 32 - numBits;
  return fromBits((this.low << n) | (this.high >>> numBits), (this.high << n) | (this.low >>> numBits), this.unsigned);
};
LongProto.rotr = LongProto.rotateRight;

LongProto.toSigned   = function () { return this.unsigned ? fromBits(this.low, this.high, false) : this; };
LongProto.toUnsigned = function () { return this.unsigned ? this : fromBits(this.low, this.high, true); };

/** Serialize to a byte array, little-endian or big-endian. */
LongProto.toBytes = function (littleEndian) {
  return littleEndian ? this.toBytesLE() : this.toBytesBE();
};

LongProto.toBytesLE = function () {
  const h = this.high, l = this.low;
  return [
    l         & 0xFF, (l >>> 8)  & 0xFF, (l >>> 16) & 0xFF, l >>> 24,
    h         & 0xFF, (h >>> 8)  & 0xFF, (h >>> 16) & 0xFF, h >>> 24,
  ];
};
LongProto.toBytesBE = function () {
  const h = this.high, l = this.low;
  return [
    h >>> 24, (h >>> 16) & 0xFF, (h >>> 8) & 0xFF, h & 0xFF,
    l >>> 24, (l >>> 16) & 0xFF, (l >>> 8) & 0xFF, l & 0xFF,
  ];
};

Long.fromBytes = function (bytes, unsigned, littleEndian) {
  return littleEndian ? Long.fromBytesLE(bytes, unsigned) : Long.fromBytesBE(bytes, unsigned);
};
Long.fromBytesLE = function (bytes, unsigned) {
  return new Long(
    bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24),
    bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24),
    unsigned
  );
};
Long.fromBytesBE = function (bytes, unsigned) {
  return new Long(
    (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7],
    (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3],
    unsigned
  );
};

// BigInt interop (only installed when BigInt is available)
if (typeof BigInt === "function") {
  Long.fromBigInt = function (value, unsigned) {
    const lo = Number(BigInt.asIntN(32, value));
    const hi = Number(BigInt.asIntN(32, value >> BigInt(32)));
    return fromBits(lo, hi, unsigned);
  };
  Long.fromValue = function (value, unsigned) {
    return typeof value === "bigint" ? Long.fromBigInt(value, unsigned) : fromValue(value, unsigned);
  };
  LongProto.toBigInt = function () {
    const lo = BigInt(this.low >>> 0);
    const hi = BigInt(this.unsigned ? this.high >>> 0 : this.high);
    return (hi << BigInt(32)) | lo;
  };
}

// ============================================================
// SECTION 5 – SEED PARSING
// ============================================================

/**
 * Simple Java-style string hash (djb2 variant).
 * Used to convert non-numeric seeds (e.g. "MyWorld") to a 32-bit integer
 * before interpretation as a 64-bit Long.
 *
 * @param {string} str
 * @returns {number} 32-bit signed integer hash
 */
function hashSeed(str) {
  let hash = 0;
  if (str.length === 0) return hash;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Force 32-bit integer
  }
  return hash;
}

/**
 * Parse a seed string into a 64-bit Long suitable for the WASM World constructor.
 *
 * - If `seedStr` is already a valid 64-bit decimal integer, use it directly.
 * - Otherwise hash it (matching Minecraft's Java behaviour for text seeds).
 *
 * Returns an object with:
 *   isHashed   – true when the seed had to be hashed
 *   inputSeed  – the original input string
 *   longSeed   – the Long value
 *   stringSeed – the decimal string that was ultimately parsed
 */
function parseSeed(seedStr) {
  let isHashed = false;
  let trimmed  = seedStr.trim();
  let longSeed;

  try {
    longSeed = Long.fromString(trimmed);
  } catch (_) {
    // Not a valid integer string
  }

  // Validate: re-stringify and compare to catch out-of-range values
  if (!longSeed || longSeed.toString() !== trimmed) {
    trimmed  = `${hashSeed(trimmed)}`;
    longSeed = Long.fromString(trimmed);
    isHashed = true;
  }

  return {
    isHashed,
    inputSeed:  seedStr,
    longSeed,
    stringSeed: trimmed,
  };
}

// ============================================================
// SECTION 6 – UTILITIES
// ============================================================

/**
 * Compute the Manhattan distance between two 3D positions.
 * Used to sort ore clusters by proximity to the player's position.
 *
 * @param {number[]} a - [x, y, z]
 * @param {number[]} b - [x, y, z]
 * @returns {number}
 */
function manhattanDistance(a, b) {
  return (
    Math.abs(a[0] - b[0]) +
    Math.abs(a[1] - b[1]) +
    Math.abs(a[2] - b[2])
  );
}

// ============================================================
// SECTION 7 – findOres (main exported function)
// ============================================================

/**
 * Find ore clusters near a given position in a Minecraft world.
 *
 * This is the function exposed to the main thread via Comlink.
 *
 * @param {object} params
 * @param {string}   params.seed         - World seed (numeric or text)
 * @param {string}   params.platform     - Platform key, e.g. "java_1_20"
 * @param {string}   params.ore          - Ore key, e.g. "diamond"
 * @param {number[]} params.position     - Player position [x, y, z]
 * @param {number}   params.chunkRadius  - Search radius in chunks
 * @param {string}   params.filter       - Size filter: "all" | "medium" | "big"
 * @param {number}   params.limit        - Maximum number of results to return
 *
 * @returns {Promise<object[]>} Sorted array of ore cluster objects
 */
async function findOres(params) {
  // Load the compiled Rust/WASM module.
  // NOTE: In the real bundled worker (inside _WORKER_B64_ in index.html) the
  // WASM binary is inlined — no external file is fetched.  This import path
  // is an artefact of de-minification and would only work if rust-local.js
  // were served from the same directory as a real file.
  const { OreFinder, Zone, World } = await import("./rust-local.js");

  const platformConfig = platforms[params.platform];
  const parsedSeed     = parseSeed(params.seed);

  // Construct the WASM World from the 64-bit seed and platform metadata
  const world = new World(
    parsedSeed.longSeed.low,   // low 32 bits of seed
    parsedSeed.longSeed.high,  // high 32 bits of seed
    platformConfig.edition,
    platformConfig.version,
    undefined,                 // extra options (unused)
    false                      // isLargeFeatures
  );

  const finder = new OreFinder(world, ores[params.ore].oreType);

  try {
    // Convert player position to chunk coordinates
    const chunkX = params.position[0] >> 4;
    const chunkZ = params.position[2] >> 4;

    // Build the rectangular zone of chunks to search
    const zone = new Zone(
      chunkX - params.chunkRadius,
      chunkZ - params.chunkRadius,
      params.chunkRadius * 2 + 1,
      params.chunkRadius * 2 + 1
    );

    // Run the WASM search
    let results = await finder.find(zone);

    // ── Filter ────────────────────────────────────────────
    results = results.filter((cluster) => {
      // Discard low-confidence clusters
      if (cluster.confidence === Confidence.LOW) return false;

      // Attach ore type to cluster (used by getSize)
      cluster.type = params.ore;

      const size = ores[params.ore].getSize(cluster, params.platform);

      // Apply size filter:
      //   filter="big"    → keep only big
      //   filter="medium" → keep big + medium
      //   filter="all"    → keep everything
      if (size === "medium" && params.filter === "big") return false;
      if (size === "small"  && ["big", "medium"].includes(params.filter)) return false;

      return true;
    });

    // ── Sort by distance from player ──────────────────────
    results = results.sort(
      (a, b) =>
        manhattanDistance(params.position, [a.x, a.y, a.z]) -
        manhattanDistance(params.position, [b.x, b.y, b.z])
    );

    // ── Limit result count ────────────────────────────────
    results = results.slice(0, params.limit);

    return results;

  } finally {
    // Always free the WASM OreFinder to prevent memory leaks
    finder.free();
  }
}

// ============================================================
// SECTION 8 – COMLINK EXPORT
// ============================================================

/**
 * The namespace object exposed via Comlink.
 * The main thread calls `proxy.findOres(params)` which is forwarded here.
 */
const workerApi = Object.freeze({
  __proto__: null,
  findOres,
});

// Expose the API on this worker's global scope so the main thread
// can communicate with it via the Comlink RPC protocol.
expose(workerApi);
