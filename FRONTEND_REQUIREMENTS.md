# Frontend Requirements for the Investment App

This document lists the frontend pages, flows, and shared UI features that should exist based on the current backend.

---

## 1) Core Frontend Pages

### Public pages

| Page | Suggested Route | Purpose | Backend Endpoints |
| --- | --- | --- | --- |
| Landing page | `/` | Intro, CTA, app overview | optional only |
| Register | `/register` | Create account | `POST /api/v1/register` |
| Login | `/login` | Sign in | `POST /api/v1/login` |
| Forgot password | `/forgot-password` | Request OTP/reset flow | forgot-password endpoints already supported in auth flow |
| Verify email | `/verify-email` | Verify newly registered user | `POST /api/v1/send-verification`, `POST /api/v1/verify-email` |

### Protected user pages

| Page | Suggested Route | Purpose | Backend Endpoints |
| --- | --- | --- | --- |
| Dashboard | `/dashboard` | Main summary view with portfolio health, alerts, notifications, recommendations | `GET /api/v1/portfolio/dashboard` |
| Portfolio overview | `/portfolio` | Holdings, cash balance, invested amount, profit/loss | `GET /api/v1/portfolio` |
| Portfolio analytics | `/portfolio/analytics` | Allocation, returns, gainers/losers, benchmark comparison, risk | `GET /api/v1/portfolio/analytics` |
| Performance history | `/portfolio/history` | Chart view for historical performance | `GET /api/v1/portfolio/performance-history` |
| Transactions | `/transactions` | Filterable transaction history | `GET /api/v1/portfolio/transactions` |
| Alerts | `/alerts` | List and manage price alerts | `GET /api/v1/portfolio/alerts`, `POST /api/v1/portfolio/alerts`, `DELETE /api/v1/portfolio/alerts/:id` |
| Notifications | `/notifications` | In-app notifications center | `GET /api/v1/notifications`, `PATCH /api/v1/notifications/:id/read`, `PATCH /api/v1/notifications/read-all` |
| Account/Profile | `/account` | User profile and account details | `GET /api/v1/me` |
| Sessions | `/sessions` | View and revoke active login sessions | `GET /api/v1/sessions`, `DELETE /api/v1/sessions/:id`, `POST /api/v1/logout-all` |

### Admin pages

| Page | Suggested Route | Purpose | Backend Endpoints |
| --- | --- | --- | --- |
| Admin overview | `/admin` | High-level admin metrics | `GET /api/v1/admin/overview` |
| Security status | `/admin/security` | View security posture/config summary | `GET /api/v1/admin/security-status` |
| API docs viewer (optional) | `/admin/docs` | Internal API contract reference | `GET /api/v1/docs/openapi.json` |

---

## 2) Actions That Can Be Modals or Separate Pages

These do not need full pages if you prefer a dashboard-style UX:

- **Buy stock** — `POST /api/v1/portfolio/buy`
- **Sell stock** — `POST /api/v1/portfolio/sell`
- **Deposit funds** — `POST /api/v1/deposits/manual` (pending review; admin approval required)
- **Withdraw funds** — `POST /api/v1/withdrawals/manual` (pending review; admin approval required)
- **Create alert** — `POST /api/v1/portfolio/alerts`

Recommended: build these as **modal forms** opened from the dashboard or portfolio page.

---

## 3) Shared Frontend Features Needed

### Authentication layer
- auth context/store
- protected route guard
- bearer token handling
- refresh token flow
- logout / logout-all support
- session expiry handling

### Reusable UI components
- navbar/sidebar
- summary cards
- holdings table
- transactions table with filters
- analytics charts
- alerts list/table
- notifications dropdown/panel
- confirmation modal for destructive actions
- loading, empty, and error states

### API integration utilities
- centralized API client
- automatic `Authorization: Bearer <token>` support
- retry on refresh-token success
- toast/snackbar error handling

---

## 4) Recommended Frontend Route Structure

```text
/
/login
/register
/forgot-password
/verify-email
/dashboard
/portfolio
/portfolio/analytics
/portfolio/history
/transactions
/alerts
/notifications
/account
/sessions
/admin
/admin/security
/admin/docs
```

---

## 5) MVP Build Order

Build the frontend in this order:

1. **Login / Register / Verify Email**
2. **Dashboard**
3. **Portfolio Overview**
4. **Buy / Sell / Deposit / Withdraw modals**
5. **Transactions page**
6. **Analytics + history charts**
7. **Alerts management**
8. **Notifications center**
9. **Account + sessions page**
10. **Admin pages**

---

## 6) Minimum State You Will Need on the Frontend

At minimum, the frontend should track:

- authenticated user
- access token
- refresh token
- portfolio summary
- holdings list
- analytics payload
- notifications list
- alerts list
- transactions filters (`page`, `limit`, `type`, `symbol`, `startDate`, `endDate`)

---

## 7) Suggested Tech Notes

If you are building the frontend later, a clean stack would be:

- **React + Vite** or **Next.js**
- **React Router** for routes
- **Axios/fetch wrapper** for API calls
- **Context API**, Zustand, or Redux for auth/app state
- **Chart library** for analytics (`recharts`, `chart.js`, or `nivo`)
- **Tailwind CSS** or another component system for UI styling

---

## 8) Final Note

The backend is already prepared for:
- authentication
- portfolio actions
- analytics
- alerts
- notifications
- admin monitoring
- API docs

So the frontend work now is mainly **page construction, API integration, and UI state management**.
