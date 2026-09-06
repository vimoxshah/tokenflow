/**
 * Newline-delimited JSON-RPC 2.0 over a pair of streams.
 *
 * This is the framing half of `tokenflow mcp`. MCP's stdio transport is plain
 * JSON-RPC 2.0 with one message per line and no embedded newlines
 * (modelcontextprotocol.io, "Transports > stdio"), so nothing here needs a
 * dependency: read lines, parse, dispatch, write one line back.
 *
 * Two invariants this module exists to protect:
 *
 *   1. Only JSON-RPC messages ever reach the output stream. A stray log line
 *      on stdout corrupts the framing and the client drops the connection, so
 *      every diagnostic goes through the caller's `log` (stderr) instead.
 *   2. A tool that fails is not a protocol failure. This layer only produces
 *      the five JSON-RPC error objects below; anything a handler wants to
 *      report to the model it returns as an ordinary result.
 *
 * Robustness rules, each of which is a real client behaviour rather than a
 * hypothetical: a blank keepalive line is ignored, a batch (top-level array)
 * is refused with "Invalid Request" instead of crashing, a *response* from the
 * client is dropped rather than answered (answering a reply is how two servers
 * talk to each other forever), and once the output pipe breaks nothing further
 * is written to it.
 */
import readline from 'node:readline';

/** JSON-RPC 2.0 reserved error codes (jsonrpc.org/specification, section 5.1). */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** An error a handler wants reported as a JSON-RPC error object, with its code. */
export class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   * @param {any} [data]
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** @param {string} message @param {any} [data] */
export function invalidParams(message, data) {
  return new RpcError(INVALID_PARAMS, message, data);
}

/** @param {string|number|null} id @param {any} result */
export function resultMessage(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** @param {string|number|null} id @param {number} code @param {string} message @param {any} [data] */
export function errorMessage(id, code, message, data) {
  /** @type {{code:number, message:string, data?:any}} */
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

/**
 * What a parsed message is, by the shape rules in the JSON-RPC 2.0 spec.
 * A batch (array) counts as invalid: MCP dropped batching, and a server that
 * throws on one is worse than a server that says no.
 * @param {any} msg
 * @returns {'request'|'notification'|'response'|'invalid'}
 */
export function classify(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'invalid';
  if (msg.jsonrpc !== '2.0') return 'invalid';
  if (typeof msg.method === 'string') {
    if (msg.id === undefined || msg.id === null) return 'notification';
    if (typeof msg.id === 'number' || typeof msg.id === 'string') return 'request';
    return 'invalid';
  }
  if ('result' in msg || 'error' in msg) return 'response';
  return 'invalid';
}

/** The id to echo in an error response: only a number or a string is usable. */
function idOf(msg) {
  const id = msg && typeof msg === 'object' ? msg.id : null;
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

/**
 * Serve JSON-RPC over `input`/`output` until the input ends or the output pipe
 * breaks. Handlers are looked up by method name and may be async; their return
 * value becomes the `result`. Throw an `RpcError` for a specific code, anything
 * else becomes an internal error.
 *
 * @param {object} opt
 * @param {import('node:stream').Readable} opt.input
 * @param {import('node:stream').Writable} opt.output
 * @param {Record<string, (params:any, msg:any)=>any>} opt.handlers
 * @param {(message:string)=>void} [opt.log] diagnostics sink, never the output stream
 * @returns {{done:Promise<void>, write:(msg:any)=>void, close:()=>void}}
 */
export function createConnection({ input, output, handlers = {}, log = () => {} }) {
  let closed = false;
  // Lines are handled one at a time, so responses leave in the order the
  // requests arrived. The spec allows any order (every response carries its
  // id), but nothing this server does is I/O bound, so serialising costs
  // nothing and makes the stream predictable to read and to test.
  let queue = Promise.resolve();

  const write = (msg) => {
    if (closed) return;
    try {
      output.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      // The pipe went away mid-write. Stop writing rather than throw: the
      // client has left, and there is nobody to report the failure to.
      closed = true;
      log(`write failed: ${err.message}`);
    }
  };

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const onOutputError = (err) => {
    closed = true;
    // EPIPE is the client closing our stdout. That is a normal end of session,
    // not a fault, so it is not logged; anything else is worth saying.
    if (err && err.code !== 'EPIPE') log(`output stream error: ${err.message}`);
    rl.close();
  };
  output.on('error', onOutputError);

  async function handleLine(line) {
    const text = line.trim();
    if (!text) return; // blank keepalive line

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      write(errorMessage(null, PARSE_ERROR, 'Parse error: line is not valid JSON'));
      return;
    }

    const kind = classify(msg);
    if (kind === 'response') return; // a reply to something we sent; never answer a reply
    if (kind === 'invalid') {
      write(errorMessage(idOf(msg), INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC 2.0 request object'));
      return;
    }

    const handler = Object.prototype.hasOwnProperty.call(handlers, msg.method) ? handlers[msg.method] : null;

    if (kind === 'notification') {
      // An unknown notification is ignored by design: a client may send ones
      // this server never declared, and a notification has no reply channel.
      if (!handler) return;
      try {
        await handler(msg.params ?? {}, msg);
      } catch (err) {
        log(`notification ${msg.method} failed: ${err.message}`);
      }
      return;
    }

    if (!handler) {
      write(errorMessage(msg.id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`));
      return;
    }
    if (msg.params !== undefined && (msg.params === null || typeof msg.params !== 'object' || Array.isArray(msg.params))) {
      write(errorMessage(msg.id, INVALID_PARAMS, 'Invalid params: expected an object'));
      return;
    }

    try {
      const result = await handler(msg.params ?? {}, msg);
      write(resultMessage(msg.id, result === undefined ? {} : result));
    } catch (err) {
      if (err instanceof RpcError) {
        write(errorMessage(msg.id, err.code, err.message, err.data));
      } else {
        log(`${msg.method} failed: ${err.stack || err.message}`);
        write(errorMessage(msg.id, INTERNAL_ERROR, `Internal error: ${err.message}`));
      }
    }
  }

  rl.on('line', (line) => {
    queue = queue.then(() => handleLine(line)).catch((err) => log(`dispatch failed: ${err.message}`));
  });

  const done = new Promise((resolve) => {
    // `close` fires after the last `line`, so the queue captured here is the
    // final one: awaiting it means a response still being computed when stdin
    // ended is written before the server reports itself finished.
    rl.once('close', async () => {
      await queue;
      output.removeListener('error', onOutputError);
      resolve();
    });
  });

  return { done, write, close: () => rl.close() };
}
