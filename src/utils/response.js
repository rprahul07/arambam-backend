/**
 * The success envelope every endpoint answers with:
 *
 *   { success: true, message: string, data: T }
 *
 * List endpoints add `meta` with the pagination cursor. The front end reads
 * `data` and nothing else, so the shape of `data` is always exactly the domain
 * object described in `arambham-frontend/src/types/index.ts`.
 */
export const ok = (res, data = null, message = 'Success', status = 200, extra = {}) =>
  res.status(status).json({ success: true, message, data, ...extra });

export const created = (res, data = null, message = 'Created') => ok(res, data, message, 201);

export const noContent = (res) => res.status(204).send();

export const paginated = (res, rows, meta, message = 'Success') =>
  res.status(200).json({ success: true, message, data: rows, meta });

export default { ok, created, noContent, paginated };
