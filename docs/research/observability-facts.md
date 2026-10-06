# Observability facts for issue #10 (free tier, no card)

Checked 2026-10-06 against first-party docs/pricing pages. Pages were read via a fetch-and-summarize tool, so exact quotes come from that extraction; items marked **UNVERIFIED** were not stated by the owning source. Not repeated here: hosting/ops facts from `research/free-hosting` and `research/ops-facts`.

## 1. Render free web service: logs

Source: https://render.com/docs/logging (2026-10-06)
- Retention in the dashboard log explorer is by workspace plan: Hobby 7 days, Pro 14 days, Scale/Enterprise 30 days. Older logs are gone even after upgrading. (Free web services live in a Hobby workspace; the page lists Hobby as the lowest tier. The page does not use the word "free" for this row - mild inference.)
- Volume limit: max 6,000 application log lines per minute per running instance; excess is dropped from the explorer and from log streams.
- HTTP request logs in the explorer need a Pro workspace or higher. So on free, only application stdout (Pino JSON) is visible; Render does not log requests for you, so Pino must log them.
- Log streams: https://render.com/docs/log-streams (2026-10-06) says all plans can set a default log stream destination; Pro+ can omit services; Scale+ can set per-service destinations. The page does not restrict free/Hobby from streaming. Protocol is syslog over TLS (RFC5424), or HTTPS for Datadog/Loggly. Syslog providers listed: Better Stack, Coralogix, LaunchDarkly, Mezmo, New Relic, Papertrail, SolarWinds, Sumo Logic. Grafana Cloud/Loki is NOT in the list. Stream traffic does not count against outbound bandwidth.
- Caveat: https://render.com/pricing returned no plan table via the fetch tool, so the plan matrix there is **UNVERIFIED**; downstream providers' own free tiers (and card requirements) must be checked separately.

## 2. Free external tiers (card-free)

| Service | Free limits | Interval | Retention | Alerts | Terms | Source |
|---|---|---|---|---|---|---|
| UptimeRobot | 50 monitors | 5 min | 3 months logs | 5 integrations (Google Chat, Discord, Pushover, Pushbullet, Splunk listed); SMS/voice not included; email not itemized on page (**UNVERIFIED**) | Pricing page: "Good for hobby and non-profit projects". Terms page: "available for any use, including commercial and business use." Sources conflict; treat commercial use as ambiguous. "No credit card required!" | https://uptimerobot.com/pricing/ , https://uptimerobot.com/terms/ |
| Better Stack (Uptime) | 10 monitors, 10 heartbeats, 1 status page | 3 min | log retention for free **UNVERIFIED** (paid telemetry bundles quote 30 days) | Slack/email | commercial terms not checked; card requirement not stated (**UNVERIFIED**); free log ingest quota **UNVERIFIED** | https://betterstack.com/uptime , https://betterstack.com/pricing |
| Grafana Cloud | Logs 50 GB/mo, metrics 10k series, traces 50 GB, 3 users | n/a (Synthetics 100k executions/mo) | 14 days (logs/metrics/traces) | alerting present, channels not itemized (**UNVERIFIED**) | "No credit card required", never expires. ToS says services are for "professional use only, and not for consumer purposes"; no free-tier commercial restriction found. Not in Render's stream provider list, so ingestion needs an in-app shipper. | https://grafana.com/pricing/ , https://grafana.com/legal/terms/ |
| Sentry Developer | 1 user, 5,000 errors/mo, 1 uptime monitor, 1 cron monitor | uptime interval **UNVERIFIED** | 30 days | email alerts | card requirement not stated (**UNVERIFIED**); non-commercial restriction not found | https://sentry.io/pricing/ |
| Healthchecks.io Hobbyist | 20 checks, 100 log entries per check (about 8 h of history at 5-min cadence) | cron-style heartbeats (dead-man switch, not outbound probe) | 100 pings/check | email plus many integrations; SMS/WhatsApp/phone not included | "No payment method"; no commercial ban found; Supporter plan is optional | https://healthchecks.io/pricing/ , https://healthchecks.io/docs/configuring_notifications/ |

Fit note: Healthchecks.io is the natural fit for the GitHub Actions scheduled job (job pings it; silence = alert); UptimeRobot/Better Stack are external probes of the Render API.

## 3. Pinging Render free web service every 5 minutes

Source: https://render.com/docs/free (2026-10-06)
- Spins down after "15 minutes without receiving any inbound traffic," which "includes both HTTP requests and WebSocket messages from existing connections." Wakes on next HTTP request/WebSocket connection, taking about one minute.
- The page does not mention monitors, health checks or keep-alive. So whether an external monitor's HTTP GET resets the idle timer is not stated explicitly; by the definition above (any inbound HTTP request) a 5-minute probe (< 15 min) should keep it awake. Treat as strong inference, **UNVERIFIED** by Render. https://render.com/docs/health-checks says health checks apply to web/private services but says nothing about free-tier idle behavior, so Render's own internal health checks as idle-timer resets are **UNVERIFIED**.
- Hours: 750 free instance hours per workspace per calendar month, consumed only while running; spun-down time is free; on exhaustion all Free web services in the workspace are suspended until next month.
- Arithmetic, 31-day month: 31 x 24 = 744 h < 750 h, leaving 6 h of headroom. A service kept awake 24/7 therefore fits, but only one such service per workspace (a second always-on service would exceed 750). Real monthly usage also includes redeploy/boot overlap, so the margin is thin.
- Related: Render may suspend a Free web service that initiates uncommonly high outbound traffic. No ban on keep-alive pings is stated.

## 4. GitHub Actions

- Auto-disable: "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days." (https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow and https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows). The docs do not define "repository activity", so whether the scheduled runs themselves count is **UNVERIFIED** (the fetched text does not say; do not rely on it - plan for periodic commits or a keep-alive step/manual re-enable).
- Scheduling: only on default branch; can be delayed at high load (start of every hour); minimum interval 5 minutes.
- Notifications (https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/notifications-for-workflow-runs): with email or web notifications enabled for Actions you are notified of runs you triggered, with option "only when a workflow run has failed". For scheduled workflows the recipient is a user, but the pages disagree on who: the events page says "the user who last modified the cron syntax in the workflow file"; the notifications page says "the user who initially created the workflow", switching to whoever modifies the cron, or whoever re-enables a disabled workflow. Either way for a solo repo it is the owner.
- Default: that email goes by default is **UNVERIFIED** - the docs fetched do not state the default for Actions notifications. Practitioners must confirm at https://github.com/settings/notifications (Actions section: email vs. GitHub, "failed workflows only") and verify with a deliberately failing run.
