# STEMBot implementation status

Review and implementation date: 22 October 2026. This file records the verified state of the three coordinated projects after the initial integration work and the latest Website/STEMCraft fixes. The deployed endpoints were queried directly; local repository source was inspected after fetching both remotes. No Website or STEMCraft files were changed by this task.

Priority levels:

- **P0** — blocks safe production operation or a required privacy/data contract.
- **P1** — required for the intended first production feature set.
- **P2** — hardening, operational improvements, or future capability.

## Completed functionality

### STEMBot repository

- Strict TypeScript/NodeNext project with ESLint, Prettier, Vitest, build validation, and a locked dependency tree.
- Environment-based configuration for Discord credentials, external URLs, request timeouts, polling, timezone, channel IDs, reminder switches, announcement switches, optional STEMCraft bearer token, optional OpenAI counting-chain settings, state path, and shutdown deadline.
- Discord client using the `Guilds` gateway intent by default, with opt-in `GuildMessages` and `MessageContent` intents for the counting-chain minigame, structured Pino logging, interaction routing, graceful shutdown, and generic command error handling.
- Node.js outbound networking prefers IPv4 to avoid dual-stack REST callback delays on TrueNAS deployments where IPv6 is advertised but unavailable.
- Production Compose configuration provides configurable explicit DNS resolvers for deployments whose default container resolver cannot reach Discord reliably.
- Slash commands `/ping`, `/workshops`, `/joke`, `/review`, `/minecraft`, and `/players` are synchronized by a replacement script before every bot startup. It explicitly removes existing global registrations, clears the global set, and replaces the configured single guild set; the same operation remains available as an explicit manual command.
- `/ping` uses one immediate Discord response. Interaction handling records IDs for a short deduplication window and identifies expired acknowledgements without attempting a second invalid response.
- `/workshops` lists future non-cancelled feed items, sorts by start time, formats offset-aware dates in the configured timezone, and uses a single `Details` link for each workshop.
- `/joke` serves a randomly selected robot-themed joke from a local set of more than 100 unique jokes.
- `/minecraft` reports online state, maintenance, player count, capacity, version, and an optional status message.
- `/players` is available without a role gate and outputs usernames only. The adapter rejects the operation with a specific capability result when the upstream response has no player array.
- Optional counting-chain minigame watches one configured channel for image attachments and HTTPS direct/embed image URLs, samples GIF frames, uses the OpenAI Responses API with low-effort bounded reasoning to identify a positive integer from digits, number words, clear corrective phrases, and intentional finger gestures, reacts with `👍` for accepted numbers, resets with `❌` for wrong numbers or consecutive users, and uses `⚠️` without changing state when review is disabled and the image cannot be read. When image recognition returns no number, it falls back to one unambiguous positive integer in the image filename or an explicit `number`, `count`, or `value` URL parameter; provider IDs and conflicting URL values are ignored. Remote image hosts are provider-agnostic but must resolve to public addresses and pass HTTPS, redirect, image-type, timeout, and size checks. Existing higher-effort deployments retry once at low effort when the API reports an exhausted output budget. At every startup it paginates Discord history in 100-message pages and reconciles image messages newer than the persisted `lastProcessedMessageId` in chronological order, so posts made while the bot was offline are processed once and the checkpoint survives restarts. Live message and embed-update events also reconcile the recent channel window in message-ID order to avoid judging a later post before an earlier embed is available. Optional moderator review persists the last game-ending image, pings the configured role, pauses newer posts, deletes its temporary request message after a decision, and allows authorized `✅` approval or `❌` rejection; `/review` resolves that persisted image without requiring a member to provide a message ID. Legacy records without the checkpoint still recover the latest relevant image or silently reset on a failure marker. An optional info channel maintains a single live status embed with persisted high-score and last-round data. Gateway receipt, attachment/image-source, and structured-response diagnostics are logged without recording image data.
- Optional AI STEM question chain posts one structured question at a time in a configured channel, targets ages 8–14 with occasional harder questions through age 18, checks generated terminology and units, avoids the last 20 persisted questions and regenerates exact duplicates, awards the first accepted answer one point, acknowledges unclear answers with `🤔` without using an attempt, marks temporary evaluator failures with `⚠️` without using an attempt, reveals the answer after the configured wrong-answer limit, persists active questions, recent question history and scores across restarts, serializes answer processing, and reuses the existing OpenAI model configuration with `store=false`.
- Website RSS adapter using `fast-xml-parser`, including primary `sm:id` identity with GUID fallback, `sm:startDate`, `sm:endDate`, `sm:location`, `sm:price`, `sm:ages`, `sm:registrationType`, `sm:registrationUrl`, `sm:status`, `sm:statusCode`, `sm:type`, descriptions, enclosures, malformed-item skipping, timeout handling, and registration compatibility aliases.
- Narrow compatibility handling for older escaped XML declarations (`&quot;`); it does not broadly HTML-decode arbitrary feed content.
- STEMCraft HTTP adapter compatible with the deployed aggregate payload and username-only `players` array, plus older `online_players`, `player_list`, or camel-case arrays. It accepts optional bearer authentication and removes UUIDs/other identity fields at the integration boundary.
- Workshop synchronization job with new, meaningful update, and `sm:statusCode=cancelled` announcements. It does not infer cancellations from missing feed items, and each delivery is persisted with a feed fingerprint, pending event kind, and Discord message ID.
- Future lifecycle announcements wait until the workshop is within the configurable 28-day announcement window; cancellation transitions remain eligible outside that window.
- 24-hour and 1-hour reminders driven by the workshop start instant. Late polling after a restart can still deliver a reminder while the workshop is in the future; cancelled workshops are skipped.
- Workshop announcements and reminders use plain Discord messages with emoji prefixes, bold linked titles, longer workshop details, standalone varied registration calls to action, and the Website feed's HTTPS hero image uploaded as a normal attachment. Ticket links use `Book now` and interest links use `Register interest`; the duplicate `Details` row is omitted because the heading is already linked. Feed descriptions preserve basic formatting, stop before `Learning Outcomes`, and remove the generated date/location suffix. Truncated RSS summaries are enriched from the linked workshop page when its content article is available. Lifecycle announcements are delayed by the configured 30-minute default so early feed changes can be included.
- Persistent atomic JSON state mounted by Docker. Reminder keys and announcement fingerprints survive restarts and prevent normal duplicate delivery.
- Tests for configuration validation, RSS parsing and date conversion, legacy XML compatibility, STEMCraft response compatibility, command formatting and permissions, workshop lifecycle announcements, reminder idempotency, counting-chain progression/reset/restart/history recovery behavior, moderator review decisions and persisted pending review state, AI STEM quiz generation/evaluation and restart behavior, OpenAI structured image responses, and the existing state store.
- README and `.env.example` updated for the implemented commands, contracts, deployment, security, and remaining blockers.
- Deployment, contributing and security documentation, plus the GPLv3 license used by the other STEMMechanics code repositories.
- GitHub Actions container publishing to GHCR, a pull-based production Compose file, and a local Docker build override.

### Verified external contracts

#### Website RSS

The live [workshop feed](https://www.stemmechanics.com.au/workshops/feed) returned HTTP 200 with nine items during this review. Items contained `title`, `link`, `guid`, `pubDate`, `description`, an optional image enclosure, and the namespace fields `sm:id`, `sm:startDate`, `sm:endDate`, `sm:location`, `sm:price`, `sm:ages`, `sm:registrationType`, `sm:registrationUrl`, `sm:status`, `sm:statusCode`, and `sm:type`. The ISO timestamps include offsets, for example `2026-10-24T16:00:00+10:00`; the adapter converts these to correct instants without guessing a timezone. The deployed feed starts with a literal `<?xml version="1.0" encoding="UTF-8"?>` declaration and parses as standard XML.

The Website source fix is commit `4ea65035` (`Fix workshop RSS XML declaration`), merged into the current deployment history. STEMBot retains its narrow escaped-declaration compatibility path for older caches or mirrors.

The final feed contract exposes `sm:id`, `sm:registrationType`, `sm:registrationUrl`, `sm:statusCode`, and `sm:type`; STEMBot now consumes those fields while retaining GUID and legacy status/registration compatibility. Registration values cover tickets, external links, interest, email, message, and none. The bot continues to use top-level start and end dates. Nested `sm:sessions` parsing is intentionally deferred.

#### STEMCraft status

The live [STEMCraft status endpoint](http://play.stemcraft.com.au:8950/status) returned HTTP 200 with `online`, `players_online`, `max_players`, `version`, `maintenance`, `message`, `players`, and `checked_at`. The current response supplied a username-only array, for example `players:["nomadjimbob"]`. The local repository contains the player-list feature (`3f61987`, merged in the `build-153` history), and its configuration makes the array optional through `web-server.status.players.enabled`. STEMBot consumes strings and remains compatible with older responses that omit the field.

The direct endpoint is HTTP only, and the embedded STEMCraft web server defaults to `127.0.0.1:8950`. The Website HTTPS proxy at `/api/stemcraft/status` provides aggregate status but omits player names, so it cannot replace the direct endpoint for `/players` without a separately approved username contract. A separate TrueNAS container needs a protected reachable path and an agreed authentication method before production use. The optional STEMBot bearer token setting is ready for a documented bearer-token contract; it does not secure the existing unauthenticated endpoint by itself.

## Bugs and incomplete functionality

### P0

#### P0-1 — Define and deploy a secure STEMCraft status path

- **What:** Choose an HTTPS reverse proxy with network ACLs or a STEMCraft-native TLS/authentication change. The protected response must include the approved username-only `players` array for `/players`, or the deployment must provide a separate protected player-list path. Document the public URL, bearer/API-key format, timeout, rate limit, and secret rotation process. Do not expose port 8950 broadly.
- **Why:** The current direct endpoint is unauthenticated HTTP and the plugin’s default bind address is loopback. A TrueNAS-hosted bot cannot safely depend on it without deployment/network work. The live Website HTTPS proxy omits player names.
- **Owner:** STEMCraft repository plus infrastructure/deployment configuration; Website only if it becomes the secure proxy for the username list.

#### P0-2 — Run exactly one STEMBot gateway process and verify the deployed image

- **What:** Remove any stopped or running duplicate STEMBot containers/services that use the same Discord token. Confirm the deployed container is using the current image and that only the configured TrueNAS service is connected to Discord. If error 10062 recurs, compare `receivedInteractionAgeMs` with `commandDurationMs` in the logs.
- **Why:** Two gateway processes can receive the same interaction. One acknowledgement invalidates the interaction token for the other process, producing Discord error 10062 and the user-facing “application did not respond” message. A long command duration with a low received age instead indicates a delayed outbound REST callback and requires the IPv4-first runtime fix from the current STEMBot image.
- **Owner:** TrueNAS/deployment configuration; the STEMBot repository now reports interaction age and duplicate-delivery details to support verification.

### P1

#### P1-1 — Add nested multi-session support after the contract is finalised

- **What:** Add parsing, identity, reminder scheduling, and Discord formatting for the proposed nested `sm:sessions` structure once the Website contract is approved.
- **Why:** STEMBot currently uses the final feed’s top-level start and end dates by design. It must not guess session boundaries or send incorrect reminders.
- **Owner:** STEMBot repository, coordinated with the Website contract.

#### P1-2 — Configure and stage Discord notification channels

- **What:** Supply announcement and reminder channel IDs, grant the bot only `View Channel`, `Send Messages`, and any required embed/link permissions, and set `WORKSHOP_ANNOUNCE_INITIAL_SYNC` deliberately before production startup.
- **Why:** Delivery is implemented but is intentionally inert without configured channel IDs. The first sync defaults to recording the current feed without posting nine historical startup announcements.
- **Owner:** STEMBot deployment configuration with Discord administrator input.

#### P1-3 — Implement administrative streaming notifications

- **What:** Define and implement authorized slash commands for scheduling/triggering Minecraft workshop start notifications, persistence for scheduled triggers, idempotency, and approved voice-channel link formatting.
- **Why:** The existing `StreamingNotificationService` remains a placeholder. Configuration fields are reserved but no commands or delivery job exist.
- **Owner:** STEMBot repository, after STEMMechanics supplies the Discord role/channel and voice-link workflow.

#### P1-4 — Add staging/end-to-end validation

- **What:** Run the bot against a staging Discord guild and deployed Website/STEMCraft contracts. Exercise new, updated, cancelled, 24-hour, 1-hour, restart, missing-channel, upstream-timeout, and permission cases.
- **Why:** Unit and adapter tests cover local behavior, but no live Discord or deployment smoke test has been run.
- **Owner:** STEMBot repository and deployment environment; contract fixtures remain owned by Website/STEMCraft.

#### P1-5 — Enable and verify counting-chain moderator review in production

- **What:** Set `COUNTING_CHAIN_REVIEW_ENABLED=true`, provide a mentionable moderator role ID, grant the bot reaction/message-history permissions, and verify `/review`, automatic review requests, ✅ approval and ❌ rejection in the deployed Discord channel.
- **Why:** The review workflow is implemented and covered by tests, but production still needs an explicit role and Discord permission configuration before moderators can use it.
- **Owner:** STEMBot deployment configuration and Discord administrator.

### P2

#### P2-1 — Close the notification crash window

- **What:** If strict at-most-once delivery is required, add a delivery/outbox reconciliation strategy using persisted Discord message IDs or an approved idempotency mechanism. Otherwise document the current at-least-once edge between a successful send and its immediate state write.
- **Why:** Persistent state prevents normal restart duplicates, but no local JSON write can be atomic with a Discord API request.
- **Owner:** STEMBot repository, with a Discord operational decision.

#### P2-2 — Add runtime health and metrics

- **What:** Expose readiness/health based on Discord connection and last successful feed/status calls, plus counters for fetch failures, announcements, reminders, retries, and skipped player lists. Add a Compose healthcheck when a signal is selected.
- **Why:** Logs are structured, but the container has no health signal for TrueNAS monitoring.
- **Owner:** STEMBot repository and deployment configuration.

#### P2-3 — Verify published Docker deployment on TrueNAS

- **What:** Run `docker compose config`, `docker compose pull`, and `docker compose up -d --no-build` against the published GHCR image. Verify dataset ownership for atomic state-file replacement, image rollback by tag, backup/restore, and secret injection.
- **Why:** The repository now publishes a pullable image and has hardened Docker/Compose configuration, but the TrueNAS pull, permissions, rollback, and runtime smoke test remain outstanding.
- **Owner:** STEMBot repository and deployment operator.

## Missing features

| Priority | Feature                        | What is missing                                                    | Owner                    |
| -------- | ------------------------------ | ------------------------------------------------------------------ | ------------------------ |
| P0       | Secure remote STEMCraft access | TLS/network/authentication deployment contract                     | STEMCraft/infrastructure |
| P1       | Multi-session courses          | Nested `sm:sessions` parsing and per-session reminders             | STEMBot/Website contract |
| P1       | Streaming notifications        | Administrative scheduling/trigger commands and voice-channel links | STEMBot/Discord policy   |
| P1       | Live staging test              | Deployed Discord and external contract smoke test                  | STEMBot/deployment       |
| P1       | Counting-chain review          | Moderator role, reaction permissions, and production verification  | STEMBot/deployment       |
| P2       | Health/metrics                 | Runtime health endpoint or signal and operational counters         | STEMBot/deployment       |

## Tasks requiring changes to other repositories

| Priority | Repository               | Required change                                                                              | Reason                                                                                      |
| -------- | ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| P0       | STEMCraft/infrastructure | Provide HTTPS/ACL/authenticated access to the status API and document the deployed contract. | The current remote endpoint is HTTP and unauthenticated; the Website proxy omits usernames. |

## Recommended implementation order

1. **P0:** Deploy and externally verify the secure STEMCraft network/authentication path, including the protected username array.
2. **P1:** Coordinate the nested session contract and add support only after it is finalised.
3. **P1:** Configure staging Discord channels and run the implemented commands, announcements, reminders, restart, and failure scenarios.
4. **P1:** Complete the streaming notification workflow and authorized administrative commands.
5. **P1:** Run end-to-end validation against deployed Website, STEMCraft, and Discord systems before production.
6. **P2:** Add health/metrics, verify the published image rollout on TrueNAS, and resolve the outbox/reconciliation decision.
