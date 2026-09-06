/**
 * The dashboard server's route registry.
 *
 * A registered route is an API endpoint that lives outside server.js. The
 * server dispatches to a matching entry before its own inline chain, so a new
 * tab can ship its own endpoint without anyone editing server.js — the same
 * reason src/ui/views/ exists for the UI side.
 *
 * A handler is called as `handler(req, res, url, ctx)` and owns the response
 * from that point on: nothing after it runs. Registered GET routes get exactly
 * the protection inline GET routes get today, which is loopback binding and
 * nothing else; a route that changes state must be POST, so it is covered by
 * the same-origin/token check server.js applies to every non-GET request.
 *
 * The full contract is in docs/ui-views.md under "Server routes".
 */

/**
 * The helpers a route handler is given. `config` and `paths` are lazy: they are
 * only read from disk if the handler actually asks for them.
 *
 * @typedef {object} RouteContext
 * @property {(body:any, code?:number)=>void} json respond with JSON.
 * @property {(code:number, type:string, body:any)=>void} send respond with anything else.
 * @property {(file:string)=>void} sendFile respond with a file from disk.
 * @property {()=>Promise<string>} readBody read the request body as text.
 * @property {object} config the loaded config (lazy, cached per request).
 * @property {object} paths the resolved store paths (lazy, cached per request).
 * @property {(opt?:{config?:object, receipts?:boolean})=>any} buildBundle build the aggregate bundle the UI loads. `receipts: false` skips the whole-store receipt scan, which costs seconds a route that only needs sessions should not pay.
 * @property {(query:object)=>object} queryRecords the record query behind /api/records.
 * @property {string} root the repository root.
 * @property {string} host the bound host.
 * @property {number} port the bound port (correct even when the server bound port 0).
 */

/**
 * One endpoint. `path` is matched exactly; there is no pattern syntax, because
 * a query string is a better fit for everything this dashboard needs.
 *
 * @typedef {object} Route
 * @property {string} method 'GET', 'POST', … matched case-insensitively.
 * @property {string} path e.g. '/api/receipts'.
 * @property {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, ctx: RouteContext) => any} handler
 */

import { ANNOTATIONS_ROUTES } from './annotations.js';
import { CACHE_HEALTH_ROUTES } from './cache-health.js';
import { SESSION_ROUTE } from './session.js';

/**
 * Every registered route. Order does not matter: paths are matched exactly.
 * @type {Route[]}
 */
export const ROUTES = [...ANNOTATIONS_ROUTES, ...CACHE_HEALTH_ROUTES, SESSION_ROUTE];
