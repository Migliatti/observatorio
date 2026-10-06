# Ops facts: Neon free, Render free, GitHub Actions (public repo)

Research for issue #9 (child of map #1). Complements `free-hosting.md` (not repeated). All facts checked 2026-10-06 against official pages; pages were read through a summarising fetcher, so quotes are as returned by it. Anything not confirmed is marked **UNVERIFIED**.

## 1. Neon free plan

| Fact | Finding | Source |
|---|---|---|
| History / PITR | Free: "6 hours, up to 1 GB-month" of change history, root branches only. Instant restore works within this window. | https://neon.com/docs/introduction/plans |
| Branch-based restore | Restore overwrites the root branch to a timestamp or LSN; the old state is kept automatically as backup branch `{branch_name}_old_{head_timestamp}`. Console, CLI (`neon branches restore`) and API (`POST /projects/{id}/branches/{id}/restore`). Child branches can't be restored this way. | https://neon.com/docs/introduction/branch-restore |
| Limits | 10 branches/project; 1 GB/project storage; 100 CU-hours/project/month; compute suspended when exhausted. | plans page |
| Backups | No separate scheduled-backup feature found for Free. A 6 h window is not a backup: plan periodic `pg_dump` (needs the direct string). Other snapshot features on Free: **UNVERIFIED**. | plans page |
| Connection strings | Pooled = hostname with `-pooler` (PgBouncer, transaction mode). Direct = hostname without it. Direct required for migrations, `pg_dump`, logical replication, persistent-session features. | https://neon.com/docs/connect/connection-pooling |
| `pg_advisory_lock` | Session-level advisory locks are listed as **unsupported on the pooled endpoint** (also SET/RESET, LISTEN/NOTIFY, SQL PREPARE, temp tables). Use the direct endpoint for any lock-based single-writer guard. Protocol-level prepared statements work. | connection-pooling page |
| Cold start | "typically takes a few hundred milliseconds"; scale-to-zero after 5 min idle, cannot be disabled on Free; connections are interrupted on suspend. | https://neon.com/docs/connect/connection-latency ; https://neon.com/docs/introduction/scale-to-zero |
| Timeout/retry advice | Node: `connectionTimeoutMillis: 10000`; Python `connect_timeout=10`; Prisma `connect_timeout=15`. Retry example: 5 attempts, min 4000 ms delay, with jitter. | connection-latency page |
| Roles | Extra roles can be created (`CREATE ROLE ... LOGIN PASSWORD`, console, CLI, API); limit 500 roles/branch. Roles made via console/CLI/API get `neon_superuser` membership (CREATEDB, CREATEROLE, BYPASSRLS, ...); roles made via plain SQL get only basic public-schema privileges, so GRANT explicitly. Passwords: >= 12 chars, 60 bits entropy. The page gives no per-plan role restriction, so least-privilege roles via SQL appear allowed on Free (plan-specific limits **UNVERIFIED**; test once). | https://neon.com/docs/manage/roles |

Implication: create the app/collector roles with SQL (not console) so they are not `neon_superuser`.

## 2. Render free web service

| Fact | Finding | Source |
|---|---|---|
| Spin-down | After 15 min without inbound traffic; about 1 min to restart. 750 free instance hours/workspace/month. | https://render.com/docs/free |
| Filesystem | Ephemeral; lost on redeploy, restart, spin-down. No persistent disk. No SSH/shell, no one-off jobs, single instance only, SMTP ports blocked. | https://render.com/docs/free |
| Custom domain + TLS | Free page lists "Custom domains" and "Managed TLS certificates" as supported on free web services. Render creates/renews TLS for custom domains and redirects HTTP to HTTPS. (The custom-domains page counts included domains per paid plan and does not mention Free; one fetch of it even read as "not on free", so confirm in the dashboard.) | https://render.com/docs/free ; https://render.com/docs/custom-domains |
| Auto-deploy from branch | Default on push/merge to linked branch; setting "After CI Checks Pass" deploys only when all checks succeed (success/neutral/skipped). No deploy if zero checks are detected or any fails. Free-plan availability not stated: **UNVERIFIED** (no restriction found). | https://render.com/docs/deploys |
| Deploy hooks | Secret URL per service, GET or POST, optional `ref` param; 200 started, 202 queued. Documented for GitHub Actions CI/CD. The free page's feature list does not mention hooks, so Free availability is **UNVERIFIED**. | https://render.com/docs/deploy-hooks |
| Health check path | Configurable in dashboard or `healthCheckPath` in render.yaml; 5 s response limit; deploy cancelled if checks do not pass within 15 min. Free availability not stated in either page: **UNVERIFIED**. The pricing page could not be read (no extractable table). | https://render.com/docs/health-checks |
| Pre-deploy command | "available for paid web services, private services, and background workers": **not available on free**. Runs on a separate instance with no filesystem carry-over. Run migrations from CI/Actions against Neon's direct endpoint instead (or in the start command). | https://render.com/docs/deploys |
| Node version | Priority: `NODE_VERSION` env var, `.node-version`, `.nvmrc`, `package.json` engines. Default 24.21.0 for services created on/after 2026-09-17. Avoid unbounded ranges (`>=20`). | https://render.com/docs/node-version |

## 3. GitHub Actions (public repo)

| Fact | Finding | Source |
|---|---|---|
| Cost | Free for standard GitHub-hosted runners in public repos. Job limit 6 h (hosted); workflow run 35 days. | https://docs.github.com/en/actions/administering-github-actions/usage-limits-billing-and-administration ; https://docs.github.com/en/actions/reference/limits |
| Artifact retention | Default 90 days; public repos configurable 1-90 days (private 1-400). Custom period applies only to new items. | https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization |
| Who downloads | Docs say read access to the repo is required and authentication is needed. On a public repo any signed-in GitHub user has read access, so treat artifacts as effectively public; never put secrets or personal-data dumps in them. (The "any signed-in user" step is my inference, **UNVERIFIED** verbatim.) | https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/downloading-workflow-artifacts |
| Artifact storage quota | Limits page lists 500 MB for the Free plan; applicability to public repos **UNVERIFIED** (billing page says usage is free for public repos). | https://docs.github.com/en/actions/reference/limits |
| Secrets | Repo secrets work in public repos; max 100 repo secrets, 48 KB each. Except `GITHUB_TOKEN`, secrets are not passed to workflows triggered from forks; not available to Dependabot-triggered events. Transformed secrets are not redacted in logs. | https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions |
| `services: postgres` | Linux (ubuntu) runners only. Needs `POSTGRES_PASSWORD`; health options (`pg_isready`, 10 s interval, 5 s timeout, 5 retries); map `5432:5432` when the job runs on the runner and use `localhost`; in container jobs use the service label as hostname. | https://docs.github.com/en/actions/using-containerized-services/creating-postgresql-service-containers |
| Scheduled workflows | "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days." Re-enable manually. Min interval 5 min; delayed at high load (start of every hour: avoid `:00`); runs only on default branch latest commit; actor = last editor of the cron line. | https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows |
| Keeping schedules alive | Docs state only the rule and manual re-enable. What counts as "activity" (a bot commit, a workflow run) is **UNVERIFIED** in the page read. Safe practice: make a real commit periodically, or re-enable via UI/API; verify by experiment. | events page above |

## Open items to verify by experiment
1. SQL-created least-privilege role on Neon Free (grants, login via pooled and direct).
2. Render free: deploy hook, health check path and "After CI Checks Pass" actually selectable.
3. What activity resets the 60-day schedule timer.
4. Artifact storage quota applicability to public repos.
