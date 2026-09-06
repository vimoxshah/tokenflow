/**
 * Day annotations API.
 *
 * GET returns the whole file; POST adds or removes one entry. Validation and
 * storage live in src/core/annotations.js — this file only shapes the HTTP
 * request/response and turns a validation Error into a 400.
 */
import { readAnnotations, addAnnotation, removeAnnotation } from '../../core/annotations.js';

/** @type {import('./index.js').Route[]} */
export const ANNOTATIONS_ROUTES = [
  {
    method: 'GET',
    path: '/api/annotations',
    handler: (req, res, url, ctx) => ctx.json(readAnnotations()),
  },
  {
    method: 'POST',
    path: '/api/annotations',
    handler: async (req, res, url, ctx) => {
      let body;
      try {
        body = JSON.parse((await ctx.readBody()) || '{}');
      } catch {
        return ctx.json({ error: 'invalid JSON body' }, 400);
      }
      try {
        if (body.op === 'add') {
          const item = addAnnotation({ date: body.date, text: body.text });
          return ctx.json({ ok: true, item, ...readAnnotations() });
        }
        if (body.op === 'remove') {
          const removed = removeAnnotation(body.id);
          return ctx.json({ ok: true, removed, ...readAnnotations() });
        }
        return ctx.json({ error: `unknown op "${body.op}"` }, 400);
      } catch (err) {
        return ctx.json({ error: err.message }, 400);
      }
    },
  },
];
