# Research: 100% free hosting for Node + Postgres (no card)

Resolves Migliatti/observatorio#3 (child of #1). Date checked: **2026-10-06**. Sources are official vendor docs/pricing pages only. Pages were read via a fetch-and-summarise tool, so quotes are as returned; re-verify before committing money-sensitive decisions.

Hard constraint: 100% free, no card on file; cold start acceptable.

## Per-option findings

### Render (web service + Postgres) - https://render.com/docs/free
- Web: 750 free instance hours/workspace/month; spins down after 15 min without inbound traffic, ~1 min to restart; ephemeral filesystem; no persistent disk.
- Postgres: 1 GB, one per workspace, **expires 30 days after creation** (14-day grace to upgrade, then deleted), no backups.
- Card: free services usable without a payment method; without one, Render suspends free services (bandwidth cap) or disables builds rather than charging.
- Scheduled jobs: "Other service types don't support Free instances" - only web, static, Postgres, Key Value are free. Cron job service has "minimum monthly charge of $1" (https://render.com/docs/cronjobs). Not free.
- Plan-change risk: moderate; free DB lifetime already limited (30 days).
- Verdict: web OK, **DB not viable** (30-day expiry).

### Neon (Postgres only) - https://neon.com/pricing, https://neon.com/docs/introduction/plans
- Free plan is permanent, **no credit card required**.
- 1 GB/project (20 GB/account), 100 CU-hours/project/month, scale-to-zero after 5 min (cannot be disabled on Free), 5 GB egress/project, 10 branches. Exceeding limits blocks operations until next period; no data deleted.
- Cold start: compute wakes on first connection (latency not quantified in the docs I read).
- Scheduled jobs: pg_cron supported but "Jobs only run when the compute is active" (https://neon.com/docs/extensions/pg_cron), so useless with forced scale-to-zero; use an external scheduler.
- Plan-change risk: moderate (limits are plan-defined and editable by vendor).
- Verdict: **viable** for the database.

### Supabase (Postgres only) - https://supabase.com/pricing, https://supabase.com/docs/guides/deployment/going-into-prod
- Free: 500 MB database, 2 free projects, 5 GB egress; "Free projects are paused after 1 week of inactivity" (docs: low activity in a 7-day period).
- Card requirement and Cron (pg_cron) availability on Free: **not stated on the pages read**; unverified.
- Verdict: viable if kept active (a weekly ping keeps it alive); weaker than Neon (smaller, pause semantics). Fallback option.

### Koyeb - https://www.koyeb.com/docs/faqs/pricing
- Free web service (512 MB, 0.1 vCPU) and Postgres (5 h active time, 1 GB). But "Credit card required for fraud prevention" with a $29 pre-authorization hold.
- Verdict: **not viable** (card).

### Fly.io - https://docs.fly.io/about/pricing
- "New organizations don't have a free tier"; trial is 2 h machine runtime or 7 days; card required after.
- Verdict: **not viable**.

### Cloudflare Workers (compute only) - https://developers.cloudflare.com/workers/platform/limits/, https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Free: 100,000 requests/day, 10 ms CPU per request, 5 cron triggers per account (10 ms CPU each). No cold-start sleeping in the Render sense.
- Not a real Node runtime (`nodejs_compat` subset; stubs for `child_process`, `cluster`, etc.); long-lived Express-style service and TCP Postgres drivers need adaptation. 10 ms CPU is tight for scraping/ETL.
- Verdict: viable only for thin HTTP/cron glue, not a general Node service.

### Vercel Hobby (functions + cron) - https://vercel.com/docs/cron-jobs/usage-and-pricing
- Cron on all plans, but Hobby: once per day max, precision within the hour (+/-59 min), runs as Vercel Functions under their limits. Card requirement not verified.
- Verdict: viable for daily jobs only.

### GitHub Actions (scheduler / batch runner) - https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows, https://docs.github.com/en/billing/concepts/product-billing/github-actions
- Public repos: standard runners free; private repos on Free: 2,000 min/month.
- `schedule`: shortest interval 5 min; delays at high load (start of hour; queued jobs may be dropped); in public repos scheduled workflows are **auto-disabled after 60 days without repo activity**.
- No card needed for a free GitHub account (not stated on these pages; general knowledge, unverified here).
- Verdict: **viable** as the scheduled-job runner (and it can ping/wake other services).

## Summary matrix

| Option | Role | Card | Cold start | Storage/limits | Scheduled jobs | Verdict |
|---|---|---|---|---|---|---|
| Render web | Node | No | ~1 min after 15 min idle | 750 h/mo | Paid ($1 min) | Viable (web) |
| Render Postgres | DB | No | none | 1 GB, deleted at 30 d | - | Not viable |
| Neon | DB | No | wake after 5 min idle | 1 GB, 100 CU-h | pg_cron ineffective | Viable |
| Supabase | DB | Unverified | paused after 7 d idle | 500 MB | Unverified | Fallback |
| Koyeb | both | Yes ($29 hold) | - | - | - | Not viable |
| Fly.io | both | Yes | - | no free tier | - | Not viable |
| Cloudflare Workers | compute | Unverified | none | 100k req/d, 10 ms CPU | 5 cron triggers | Glue only |
| Vercel Hobby | compute | Unverified | function cold start | daily cron | 1/day | Daily jobs only |
| GitHub Actions | scheduler | No | n/a | free public | 5 min min, 60-day disable | Viable |

## Conclusion

**Viable**, with a composed stack: Render free web service (Node, accepts ~1 min cold start) + Neon free Postgres (1 GB) + GitHub Actions `schedule` for jobs (also keeps the service warm if wanted). No card needed for these three per vendor docs. Avoid Render Postgres (30-day expiry), Koyeb and Fly.io (card).

## Risks / open items
- Plan-change risk is real for all free tiers (vendors may alter limits; Render already expires DBs). Keep the DB portable (plain `pg_dump`, no vendor-specific features) and back up from the scheduled job.
- GitHub scheduled workflows stop after 60 days of repo inactivity in public repos; add a keep-alive commit or use a private repo.
- Neon cold-start latency, Supabase/Vercel/Cloudflare card requirements: not confirmed from primary pages; check at signup.
