# PostgreSQL Migration on Render

## What changed

- The backend DB adapter now uses PostgreSQL via `pg`.
- Existing controller calls still use `db.promise().query(...)`.
- Render config now provisions a managed PostgreSQL database.
- The schema file was rewritten for PostgreSQL.

## Render setup

1. Push this backend to Render using `Backend/render.yaml`.
2. Let Render create the `grace-church-postgres` database.
3. Open the PostgreSQL database console in Render.
4. Run [schema_defaultdb.sql](./schema_defaultdb.sql).
5. If your existing DB already has the `users` table, also run:
   `migrations/2026-06-15-onboarding-tracking.sql`

## Data migration from MySQL

If your current data still lives in MySQL, export and re-import in this order:

1. `users`
2. `media`
3. `media_metadata`
4. `uploads`
5. `logs`
6. `refresh_tokens`
7. `device_tokens`
8. `customer_care_feedback`
9. `home_header_banners`
10. `event_ads`
11. `timely_reflections`
12. `youtube_channel_videos`
13. `saved_videos`
14. `app_releases`

## Important notes

- PostgreSQL does not support MySQL `ENUM`, `AUTO_INCREMENT`, or `ON DUPLICATE KEY` syntax. Those parts were converted.
- Some older duplicate legacy files still exist in the repo but may not be part of the active route tree. If you later want a full backend cleanup pass, we should remove or modernize those too.
- This migration updates the runtime adapter and the main active backend flow, but you should still test login, media creation, uploads, banners, event ads, and customer care after deployment.
