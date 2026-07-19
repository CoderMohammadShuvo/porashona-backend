# CHANGELOG – Porashona Backend

## [Unreleased] – Backend MVP Build (Prompts 1–5)

---

### REMOVED

#### Guardian Role (Prompt 1 → fully removed in Prompt 5)
- Removed `guardian_phone` as a logic-bearing column; retained only as a **functionless optional contact field** with a deprecation comment.
- Removed `group = 'Guardian'` filter from `/admin/students` endpoint.
- Removed `group = 'Guardian'` filter from `/leaderboard` endpoint.
- `src/routes/guardian.js` still exists on disk but is **not mounted** in `src/index.js` and is not reachable by any active route.
- No foreign keys, no RLS policies, no DB functions reference a guardian role anywhere in the schema.

#### Legacy XP column writes (Prompt 5)
- Replaced `increment_xp` RPC calls in `arcade.js`, `quiz.js`, `assignments.js`, and `progress.js` with calls to the canonical `award_points(p_user_id, p_reason, p_custom_delta)` function.
- The `users.xp` column is no longer written to by any active code path. It may be dropped in a future migration.

#### Legacy Digital Library data source (Prompt 5)
- `library_items` table path deprecated. `src/routes/library.js` now reads exclusively from the `notes` table, making Syllabus and Digital Library identical data sources. Subscription gate (`subscription_status = 'active'`) applied to all `/library` reads.

---

### DORMANT (Out of Scope – PRD §15)

The following routes are still mounted but return **HTTP 503 FEATURE_DORMANT** on every request. Their underlying DB tables are preserved intact for future re-enablement:

| Feature | Route | Table(s) |
|---|---|---|
| Crash Courses / Course Details | GET/POST/PATCH/DELETE /courses | crash_courses |
| Faculty Gallery | (never mounted) | — |
| Ask a Teacher | (never mounted) | — |

To re-enable a feature, remove the `router.use(dormantFeature)` call from the relevant route file.

---

### ADDED

#### Schema Tables
| Table | Prompt | Purpose |
|---|---|---|
| users extensions | 1 | Added role, class, version, subscription_status, subscription_plan, subscription_expires_at, is_suspended, ui_language, ui_language_override, onboarding_completed_at |
| payments | 1 | Bkash payment records; method='manual_grant' excluded from all revenue queries |
| audit_logs | 1 | Append-only security/change log |
| study_sessions | 2 | Pomodoro study tracking with locked_until |
| points_ledger | 2 | Canonical gamification ledger; balance = SUM(delta) per user |
| daily_point_caps | 2 | Per-user daily cap enforcement |
| streaks | 2 | Streak recovery and daily check-in |
| ai_student_scores | 3 | AI understanding evaluation results (0–10) |
| generated_notes | 3 | AI-generated study notes from uploaded PDFs |
| generated_quizzes | 3 | AI-generated MCQ quiz banks |
| notes | 4 | Admin/uploader uploaded materials (distinct from generated_notes) |
| vouchers | 4 | Redeemable point-cost discount codes |
| manual_access_grants | 4 | Admin-granted free subscriptions (excluded from revenue) |
| ai_rate_limits | 5 | Per-user rolling rate limit window for AI Edge Functions |

#### Supabase Edge Functions
| Function | Prompt | Purpose |
|---|---|---|
| bkash-initiate | 1 | Initiates Bkash payment session |
| bkash-webhook | 1 | Idempotent payment confirmation + subscription activation |
| pomodoro-penalty-check | 2 | Scheduled penalty deduction for missed study sessions |
| ai-student-score | 3 | Stateless Gemini evaluation (0–10 score per explanation) |
| ai-tutor-chat | 3 | Stateless per-request AI tutoring response |
| generate-note | 3 | PDF to AI-summarised study notes (50 page / 50 MB limit) |
| generate-quiz | 3 | Note to AI-generated MCQ quiz |
| manual-access-grant | 4 | Admin-only free account creation via service-role key |
| voucher-sheets-sync | 4 | Google Sheets append/update for voucher lifecycle |

#### RBAC Middleware (Prompt 4)
- requireContentUploader – exact role='content_uploader' check
- requireAdminOrUploader – either role passes; uploader cannot escalate to admin

#### Route Files (new)
| File | Mount | RBAC |
|---|---|---|
| src/routes/content.js | /content/notes | Admin or uploader (query-level scoping); DELETE writes audit_log |
| src/routes/vouchers.js | /vouchers | Create: admin-only; Redeem: student |
| src/routes/users-admin.js | /admin/users | Admin-only; class/version = sole authorised post-onboarding path |
| src/routes/revenue.js | /admin/revenue | Admin-only; manual_grant excluded from all queries |

---

### CHANGED

#### Bkash Webhook Idempotency (Prompt 1, verified Prompt 5)
The webhook checks paymentRow.status before executing:
- status = 'success' -> returns 200 immediately (no re-execution)
- status = 'failed' -> returns 200 immediately (no re-execution)

This guarantee is preserved across all subsequent schema changes.

#### AI Edge Function Security (Prompt 5)
All four AI Edge Functions now independently verify the caller's JWT server-side
(via supabaseAdmin.auth.getUser(token)) **before** using any value from the request body.
userId from the body is treated as a hint only — the verified JWT identity is always used.

#### Append-Only Enforcement (Prompt 5)
DB-level BEFORE DELETE triggers added on points_ledger, payments, and audit_logs.
Any hard DELETE against these tables raises a PostgreSQL exception.

Removal patterns:
- payments -> set status = 'refunded'
- points_ledger -> insert a negative-delta row
- audit_logs -> append a reversal row

#### AI Rate Limiting (Prompt 5)
Per-user rolling rate limits via check_ai_rate_limit() DB function + ai_rate_limits table:

| Function | Limit |
|---|---|
| ai-student-score | 10 calls / hour |
| ai-tutor-chat | 30 calls / hour |
| generate-note | 5 calls / 24 h |
| generate-quiz | 10 calls / 24 h |

Returns HTTP 429 on limit exceeded.

#### Leaderboard (Prompt 5)
Rewritten to derive ranking from SUM(delta) in points_ledger.
Guardian filter removed; filtered by role = 'student'.

---

### VERIFICATION CHECKS (Acceptance Criteria)

| Check | Result |
|---|---|
| No active code path depends on guardian-role data | PASS – guardian.js unmounted; neq('group','Guardian') replaced |
| Syllabus and Library return identical note records | PASS – both read from notes table with same params |
| Hard DELETE on points_ledger / payments / audit_logs in src/ | PASS – grep returns no results |
| increment_xp RPC called anywhere in src/routes | PASS – all migrated to award_points |
| Crash courses return 503 DORMANT | PASS – router.use(dormantFeature) in courses.js |
| All AI Edge Functions verify JWT independently of RLS | PASS – supabaseAdmin.auth.getUser(token) at start of every handler |
