import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { ok, created, paginated, noContent } from '../../utils/response.js';
import { toEvent } from '../../serializers/index.js';
import * as service from './events.service.js';
import { ROLES } from '../../config/constants.js';

/** GET /events */
export const list = asyncHandler(async (req, res) => {
  const { rows, meta } = await service.list(req.validatedQuery, req.user ?? null);
  return paginated(res, rows, meta);
});

/** GET /events/:idOrSlug */
export const detail = asyncHandler(async (req, res) => {
  const event = await service.findByIdOrSlug(req.params.idOrSlug);
  if (!event) throw ApiError.notFound('No event lives at that address');

  const hidden =
    event.lifecycle === 'draft' &&
    !(req.user?.role === ROLES.ADMIN || (req.user?.role === ROLES.ORGANIZER && event.organizer_id === req.user.id));
  if (hidden) throw ApiError.notFound('No event lives at that address');

  const seats = await service.seatCount(event.id);
  return ok(res, { ...toEvent(event), seats });
});

/** POST /events */
export const create = asyncHandler(async (req, res) =>
  created(res, await service.create(req.body, req.user), 'Event created'),
);

/** PATCH /events/:id */
export const update = asyncHandler(async (req, res) =>
  ok(res, await service.update(req.params.id, req.body, req.user), 'Event updated'),
);

/** PATCH /events/:id/lifecycle */
export const setLifecycle = asyncHandler(async (req, res) => {
  const event = await service.setLifecycle(req.params.id, req.body, req.user);
  const messages = {
    draft: 'Event moved back to draft',
    published: 'Event published',
    cancelled: 'Event cancelled — everyone holding a seat has been told',
    completed: 'Event marked as completed',
  };
  return ok(res, event, messages[req.body.lifecycle]);
});

/** DELETE /events/:id */
export const remove = asyncHandler(async (req, res) => {
  await service.remove(req.params.id, req.user);
  return noContent(res);
});

export default { list, detail, create, update, setLifecycle, remove };
