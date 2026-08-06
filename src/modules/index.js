import { Router } from 'express';
import env from '../config/env.js';

import authRoutes from './auth/auth.routes.js';
import bootstrapRoutes from './bootstrap/bootstrap.routes.js';
import usersRoutes from './users/users.js';
import membersRoutes from './members/members.routes.js';
import categoriesRoutes from './categories/categories.js';
import plansRoutes from './plans/plans.js';
import eventsRoutes from './events/events.routes.js';
import registrationsRoutes from './registrations/registrations.routes.js';
import subscriptionsRoutes from './subscriptions/subscriptions.js';
import paymentsRoutes from './payments/payments.routes.js';
import notificationsRoutes from './notifications/notifications.js';
import settingsRoutes from './settings/settings.js';
import uploadsRoutes from './uploads/uploads.js';

const router = Router();

/** An index of the surface, useful as a smoke test and for discovery. */
router.get('/', (req, res) =>
  res.json({
    success: true,
    message: `${env.appName} API`,
    version: '2.0.0',
    endpoints: {
      bootstrap: `${env.apiPrefix}/bootstrap`,
      auth: `${env.apiPrefix}/auth`,
      users: `${env.apiPrefix}/users`,
      members: `${env.apiPrefix}/members`,
      eventCategories: `${env.apiPrefix}/event-categories`,
      plans: `${env.apiPrefix}/plans`,
      events: `${env.apiPrefix}/events`,
      registrations: `${env.apiPrefix}/registrations`,
      subscriptions: `${env.apiPrefix}/subscriptions`,
      payments: `${env.apiPrefix}/payments`,
      notifications: `${env.apiPrefix}/notifications`,
      settings: `${env.apiPrefix}/settings`,
      uploads: `${env.apiPrefix}/uploads`,
    },
  }),
);

router.use('/bootstrap', bootstrapRoutes);
router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/members', membersRoutes);
router.use('/event-categories', categoriesRoutes);
router.use('/plans', plansRoutes);
router.use('/events', eventsRoutes);
router.use('/registrations', registrationsRoutes);
router.use('/subscriptions', subscriptionsRoutes);
router.use('/payments', paymentsRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/settings', settingsRoutes);
router.use('/uploads', uploadsRoutes);

export default router;
