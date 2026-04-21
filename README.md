# Investment App Server

Express and MongoDB backend for the investment app.

## Setup

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URI` and `JWT_SECRET`.
3. Add `ALPHA_VANTAGE_KEY` if you want live market data.
4. Run `npm install`.

Redis is optional in local development. If Redis is not running, the app starts normally and skips cache reads and writes.
MongoDB is required for full functionality, but `npm run dev` now defaults to a degraded startup mode when Atlas is unreachable so local work on health/docs or non-DB changes is not blocked.

## Run

- `npm run dev` starts the Windows-safe development launcher that cleans up stale repo Node processes before starting nodemon.
- `npm run dev:plain` starts nodemon directly without the cleanup wrapper.
- `npm start` starts the server once.

If you want development startup to fail fast when MongoDB is unavailable, run `set ALLOW_START_WITHOUT_DB=false` before `npm run dev` on Windows or set the variable in your shell/session.

The default health endpoint is `GET /health`.

## Deploy To Vercel

This backend is configured to run on Vercel using the serverless handler at `api/index.js` and route rewrites from `vercel.json`.

1. Import this `server` project into Vercel.
2. Set the framework preset to `Other`.
3. Keep Root Directory as this backend folder.
4. Add required environment variables in Vercel Project Settings:
	- `DATABASE_URI`
	- `JWT_SECRET`
5. Add recommended environment variables:
	- `NODE_ENV=production`
	- `TRUST_PROXY=true`
	- `ALLOWED_ORIGINS=https://kolskinv.vercel.app`
	- `CORS_ALLOWED_METHODS=GET,POST,PUT,PATCH,DELETE,OPTIONS`
	- `CORS_ALLOWED_HEADERS=Content-Type,Authorization`
	- `ALPHA_VANTAGE_KEY` (if using live market data)
	- `REDIS_URL` (optional)
6. Deploy.

After deployment, test these endpoints:

- `GET /health`
- `GET /api/v1/docs/openapi.json`
- `POST /api/v1/login`

If your frontend is on another domain, ensure CORS policy allows that origin.
You can allow multiple origins with a comma-separated list, for example:

`ALLOWED_ORIGINS=https://kolskinv.vercel.app,https://your-staging-frontend.vercel.app`

Current CORS behavior:

- `credentials: true` is enabled for browser auth flows.
- Origins are allowlist-only.
- Methods and headers are explicitly controlled by `CORS_ALLOWED_METHODS` and `CORS_ALLOWED_HEADERS`.

## Test

- `npm test` runs the full Jest suite.
- `npm run test:alerts` runs the analytics and alert tests.
- `npm run test:market` runs the market endpoint tests.
- `npm run test:portfolio` runs the portfolio tests.
- `npm run test:watch` runs Jest in watch mode.

## Helper Scripts

- `npm run test:auth-flow` exercises register, login, and `GET /me` against a running server.
- `npm run check:portfolio -- <userId>` looks up a portfolio by user id.
- `npm run docs:openapi` prints the bundled OpenAPI document.

`test-auth.js` accepts these optional environment variables:

- `API_BASE_URL`
- `TEST_AUTH_NAME`
- `TEST_AUTH_USERNAME`
- `TEST_AUTH_EMAIL`
- `TEST_AUTH_PASSWORD`

`check_portfolio.js` accepts a user id either as the first CLI argument or via `CHECK_PORTFOLIO_USER_ID`.

---

## API Overview

### Auth
- `POST /api/v1/register`
- `POST /api/v1/login`
- `GET /api/v1/me`
- `POST /api/v1/send-verification`
- `POST /api/v1/verify-email`
- `POST /api/v1/refresh-token`
- `POST /api/v1/logout`
- `POST /api/v1/logout-all`
- `GET /api/v1/sessions`
- `DELETE /api/v1/sessions/:id`

### Portfolio + Analytics
- `GET /api/v1/portfolio`
- `POST /api/v1/portfolio/buy`
- `POST /api/v1/portfolio/sell`
- `POST /api/v1/deposits/manual` (creates a pending manual deposit request)
- `POST /api/v1/withdrawals/manual` (creates a pending manual withdrawal request)
- `GET /api/v1/portfolio/dashboard`
- `GET /api/v1/portfolio/analytics`
- `GET /api/v1/portfolio/performance-history`
- `POST /api/v1/portfolio/reconcile`
- `GET /api/v1/portfolio/transactions`
- `GET /api/v1/portfolio/transactions/export?format=csv`

### Alerts + Notifications
- `POST /api/v1/portfolio/alerts`
- `GET /api/v1/portfolio/alerts`
- `DELETE /api/v1/portfolio/alerts/:id`
- `GET /api/v1/notifications`
- `PATCH /api/v1/notifications/:id/read`
- `PATCH /api/v1/notifications/read-all`

### Admin + Docs
- `GET /api/v1/admin/overview`
- `GET /api/v1/admin/security-status`
- `GET /api/v1/admin/deposits`
- `POST /api/v1/admin/deposits/:id/approve`
- `POST /api/v1/admin/deposits/:id/reject`
- `GET /api/v1/admin/withdrawals`
- `POST /api/v1/admin/withdrawals/:id/approve`
- `POST /api/v1/admin/withdrawals/:id/reject`
- `GET /api/v1/docs/openapi.json`

> Admin routes require a JWT with `role: admin`.

## Transaction Reporting Filters

`GET /api/v1/portfolio/transactions` supports:

- `page`
- `limit`
- `type`
- `symbol`
- `startDate`
- `endDate`

Example:

```bash
GET /api/v1/portfolio/transactions?type=buy&symbol=AAPL&startDate=2026-04-01&endDate=2026-04-09&page=1&limit=20
```

## OpenAPI document

A lightweight spec is available at:

- `GET /api/v1/docs/openapi.json`

This can be used later by the frontend or external tools as a stable API contract.