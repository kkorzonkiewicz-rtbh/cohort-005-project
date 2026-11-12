# Notification delivery services: all-in-one vs email + real-time

Research for [#13](https://github.com/kkorzonkiewicz-rtbh/cohort-005-project/issues/13) (map [#11](https://github.com/kkorzonkiewicz-rtbh/cohort-005-project/issues/11)). All pages were read on **2026-11-12**; prices change, so re-check before deciding. No vendor is picked here. That decision belongs to [#17](https://github.com/kkorzonkiewicz-rtbh/cohort-005-project/issues/17).

Constraints taken from the map: Notifications live in our SQLite database through Drizzle, and that is the source of truth. A third-party service only delivers them. In-app and email are in scope. Mobile push is out of scope, but each option's room to add it later counts. Cadence is React Router 8 (`react-router` 8.3.0, React 19) on one Node server. Email has no transport today (`app/lib/email.server.ts` only logs).

## TL;DR

- **(a) All-in-one services** (Knock, Novu, Courier, MagicBell) all keep their **own copy of each in-app message, plus read/seen/archive state**, and serve the feed from their own API over their own websocket. Using one "only for delivery" means mirroring our records into theirs and keeping read state in sync in both directions. That works against "our DB is the source of truth".
- They are cheap to free at small volume (about 1k–10k messages/month free). The first paid tier jumps to roughly **$250/month** (Knock, MagicBell, Novu Team), except Novu Pro at **$30/month** and Courier's pay-as-you-go **$0.005/send**.
- **(b) Email provider + real-time** keeps the feed, read state and preferences in our DB. Email is **$0–$20/month** at small volume: Resend 3k/month free, then $20 for 50k; Postmark $15 for 10k; SES $0.10 per 1k. Live updates in the browser can be **self-hosted SSE from a React Router resource route at $0**. On a single Node server we don't need Pusher or Ably.
- **Mobile push later**: (a) already supports APNs/FCM in the same workflow. (b) needs a third piece later (FCM/APNs directly, Pusher Beams from $0 for 1k subscribers, or similar) with our own device-token table.
- **Main trade-off**: (a) gives us a ready-made inbox UI, preferences, batching/digests and a push path, but stores a second copy of the data. (b) keeps one source of truth and costs little, but we build the inbox UI, the live updates, preferences and any digests ourselves.

## Option (a): all-in-one notification services

| Service | Free tier | First paid tier | Stores feed / read state? | In-app UI it ships | Push later |
|---|---|---|---|---|---|
| **Knock** | 10,000 messages/month, no hard cap ([pricing][knock-pricing]) | Starter $250/month incl. 50,000, then $0.005/message ([pricing][knock-pricing]) | Yes. The feed is per-user messages Knock serves, with "read, seen and archive tracking" and badge counts. Feed retention "unlimited" ([in-app overview][knock-inapp], [pricing][knock-pricing]) | Drop-in React components, or headless primitives ([in-app overview][knock-inapp]) | APNs, FCM, Expo, OneSignal, Amazon SNS ([push][knock-push]) |
| **Novu** (cloud) | 10,000 workflow runs/month, 24 h activity retention ([pricing][novu-pricing]) | Pro from $30/month (30k+ runs), Team from $250/month (250k+), overage $1.20 per 1k ([pricing][novu-pricing]) | Yes. `<Inbox />` "securely connects to Novu's services"; read state and preferences sync to the Novu backend ([inbox][novu-inbox]) | `@novu/react` `<Inbox />` (Bell, Notifications, Preferences), or headless hooks / `@novu/js`; supports React 19 ([inbox][novu-inbox]) | Push is in all plans' channel list ([pricing][novu-pricing]) |
| **Novu** (self-host) | Core is MIT, `enterprise/` is commercial ([repo][novu-repo]) | Infra cost only | Yes, in our own Novu deployment | Same | Same |
| **Courier** | Developer: 10,000 sends/month ([pricing][courier-pricing]) | Business: $0.005 per send, every send billed incl. the first 10k ([pricing][courier-pricing]) | Inbox messages are fetched by Courier's SDK after a JWT `signIn`; state syncs "instantly across a user's signed-in devices" ([inbox][courier-inbox]) | `@trycourier/courier-react` `CourierInbox` + `useCourier`; custom views on low-level APIs ([inbox][courier-inbox]) | Same SDK registers APNs/FCM tokens ([inbox][courier-inbox]) |
| **MagicBell** | Builder: 1,000 deliveries/month ([pricing][magicbell-pricing]) | Startup $249/month incl. 50,000, then $0.0025 per delivery. Deliveries count across all channels, so one in-app + one email = 2 ([pricing][magicbell-pricing]) | Product is "The Notification Inbox"; notifications are an inbox primitive it manages ([docs][magicbell-docs]) | React, Preact, Svelte, Web Components ([docs][magicbell-docs]) | APNs, FCM, Expo, Web Push ([docs][magicbell-docs]) |

Notes:

- **None of them can just render our records.** Feeds are filled by the vendor's workflows or broadcasts. Knock's feed docs say messages are generated "when a workflow runs for a recipient or when a broadcast runs" ([feeds][knock-feeds]). To use any of them, each Notification row we write must also be sent as a workflow trigger. Read/archive changes made in their UI live on their side, so we would need to sync them back by webhook or API, or give up having them in our DB.
- **Email still needs a provider underneath.** All four send email through a provider you connect (MagicBell, for example, lists SES, Mailgun, SMTP and SendGrid as channels ([docs][magicbell-docs])). So (a) is really (a) plus an email provider from (b).
- **Fit with React Router 8 / one Node server**: fine. Server side is an HTTP call from an action; client side is a React component that needs a signed user token from our loader. The websocket goes to the vendor's servers, not ours.
- **Self-hosted Novu** doesn't avoid the second copy (it is a separate MongoDB). It also brings a lot of infrastructure: API, Worker, WS and Dashboard services, Redis, MongoDB and object storage. All of it can share one VM for a small setup ([self-hosting][novu-selfhost]). That is far heavier than Cadence's single process with SQLite.

## Option (b): email provider + real-time

### Email providers

| Provider | Free | Small paid tier | Overage | Retention |
|---|---|---|---|---|
| **Resend** | 3,000/month, 100/day, 3 domains | Pro $20/month for 50,000 | $0.90 per 1k | 30 days ([pricing][resend-pricing]) |
| **Postmark** | 100/month, no overage | Basic $15/month for 10,000 (Pro $16.50, Platform $18) | $1.80 / $1.30 / $1.20 per 1k | 45 days default; Pro/Platform up to 365 days ([pricing][postmark-pricing]) |
| **Amazon SES** | AWS Free Tier credits (up to $200, 6-month plan) | Pay as you go | $0.10 per 1k + $0.12/GB attachments | n/a ([pricing][ses-pricing]) |

All three are plain HTTP APIs (or SMTP) called from Node. `sendEmail()` in `app/lib/email.server.ts` is the single place to swap the logger for a real transport. None of them stores Notifications. They keep only email delivery logs.

### Real-time to the browser

| Option | Free | Small paid tier | Push later |
|---|---|---|---|
| **Self-hosted SSE** (React Router resource route) | $0 | $0 | No. Needs a separate push service |
| **Pusher Channels** | Sandbox: 100 concurrent connections, 200k messages/day | Startup $49/month: 500 connections, 1M/day ([pricing][pusher-pricing]) | Pusher Beams is separate: free for 1,000 subscribers, $29/month for 10,000 ([Beams pricing][beams-pricing]) |
| **Ably** | 500 MAUs, 500 concurrent connections, 6M messages/month ([pricing][ably-pricing-docs], [limits][ably-limits]) | Pro $29/month (annual) / $35 (monthly) for 1,000 MAUs, $0.05 per extra MAU ([pricing][ably-pricing-docs]) | Not covered on the pricing pages read |

**Self-hosted SSE fits Cadence well:**

- In React Router 8, a route module that exports a `loader` but no default component is a resource route. It can return any `Response` ([resource routes, v8.5.1 docs][rr-resource]). A loader that returns a `ReadableStream` with `Content-Type: text/event-stream` is a Server-Sent Events endpoint. The docs don't show streaming explicitly, but it follows from returning a standard `Response`.
- `remix-utils` provides `eventStream` (`remix-utils/sse/server`) and `useEventSource` (`remix-utils/sse/react`). Its current docs say it "requires **React Router v8**" ([remix-utils][remix-utils]). That means a few lines of code rather than a hand-rolled stream.
- Because there is one Node process, an in-memory `EventEmitter` per user is enough to wake open streams when a Notification row is inserted. Pusher or Ably only become worth it with several server instances, or with a serverless host that can't keep connections open.
- The in-app feed itself is just a loader that reads our table. SSE only says "something new arrived", so the client revalidates or shows a badge. If SSE drops, the feed is still correct on the next page load.

## Requirement-by-requirement

| | (a) All-in-one | (b) Email + SSE |
|---|---|---|
| Cost at small volume | $0 inside 1k–10k msgs/month; then $30 (Novu Pro), pay-per-send (Courier), or about $250/month | $0 (Resend free + SSE) to about $15–20/month |
| Our DB as the only source of truth | No. The vendor keeps feed + read state; we must mirror and sync | Yes |
| In-app UI | Vendor components (headless option exists for Knock, Novu, Courier) | Build our own (bell, list, unread count) |
| Preferences, batching/digests | Built into workflows | Build our own |
| Fit with RR8 + single Node | Good (HTTP trigger + client SDK) | Good (resource route + `sendEmail`) |
| Push later | Built in (APNs/FCM) | Add a push service + device-token table |
| New infrastructure | None (cloud) / heavy (self-host Novu) | None |

## Open questions for #17

- Is a ready-made inbox UI and digest engine worth keeping a second copy of every Notification and its read state at a vendor?
- If (a) is chosen, which side owns read state? If the vendor does, "read" in our DB is only eventually consistent.
- Do we expect more than one server instance? That is the main reason to choose Pusher or Ably over self-hosted SSE.

## Sources (read 2026-11-12)

[knock-pricing]: https://knock.app/pricing
[knock-inapp]: https://docs.knock.app/in-app-ui/overview
[knock-feeds]: https://docs.knock.app/in-app-ui/feeds/overview
[knock-push]: https://docs.knock.app/integrations/push/overview
[novu-pricing]: https://novu.co/pricing
[novu-inbox]: https://docs.novu.co/platform/inbox/overview
[novu-selfhost]: https://docs.novu.co/community/self-hosting-novu/overview
[novu-repo]: https://github.com/novuhq/novu
[courier-pricing]: https://www.courier.com/pricing
[courier-inbox]: https://www.courier.com/docs/platform/inbox/inbox-overview
[magicbell-pricing]: https://www.magicbell.com/pricing
[magicbell-docs]: https://www.magicbell.com/docs
[resend-pricing]: https://resend.com/pricing
[postmark-pricing]: https://postmarkapp.com/pricing
[ses-pricing]: https://aws.amazon.com/ses/pricing/
[pusher-pricing]: https://pusher.com/channels/pricing/
[beams-pricing]: https://pusher.com/beams/pricing/
[ably-pricing-docs]: https://ably.com/docs/platform/pricing
[ably-limits]: https://ably.com/docs/platform/pricing/limits
[rr-resource]: https://reactrouter.com/how-to/resource-routes
[remix-utils]: https://sergiodxa.github.io/remix-utils/

- Knock: [pricing][knock-pricing], [in-app overview][knock-inapp], [feeds][knock-feeds], [push][knock-push]
- Novu: [pricing][novu-pricing], [inbox][novu-inbox], [self-hosting][novu-selfhost], [repo/license][novu-repo]
- Courier: [pricing][courier-pricing], [inbox][courier-inbox]
- MagicBell: [pricing][magicbell-pricing], [docs][magicbell-docs]
- Email: [Resend][resend-pricing], [Postmark][postmark-pricing], [Amazon SES][ses-pricing]
- Real-time: [Pusher Channels][pusher-pricing], [Pusher Beams][beams-pricing], [Ably pricing][ably-pricing-docs], [Ably limits][ably-limits]
- SSE: [React Router resource routes][rr-resource], [remix-utils][remix-utils]
