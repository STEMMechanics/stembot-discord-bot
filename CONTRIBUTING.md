# Contributing to STEMBot

STEMBot is maintained as the STEMMechanics Discord bot and is released under
the GNU General Public License, version 3. See LICENSE.

## Development setup

Use Node.js 24 and npm:

    cp .env.example .env
    npm ci

Set a development Discord token, application ID and guild ID in .env. Keep
real tokens, bearer tokens and channel IDs out of commits. The local state
file is ignored by Git.

Run the complete validation suite before submitting a change:

    npm run validate

The suite checks Prettier formatting, ESLint, TypeScript type checking, all
Vitest tests and the production build. Use npm run dev for the local
watch-mode process and npm run register:commands to register slash commands
against the configured development guild.

## Change boundaries

Keep Discord handlers, external HTTP parsing, notification policy, scheduling
and persistent state behind their existing interfaces. Add tests at the
boundary that changes: feed fixtures for RSS contract changes, status fixtures
for STEMCraft responses, command tests for user-visible output, and state
tests for deduplication or migration behavior.

Use the published Website and STEMCraft contracts. Do not invent fields,
endpoints or authentication rules when a contract is incomplete. Compatibility
fallbacks should be narrow, documented and covered by tests. The nested
sm:sessions proposal is not implemented until that contract is final.

Changes to the Website or STEMCraft repositories are coordinated separately.
A STEMBot change may document a cross-repository dependency in TODO.md, but
should not silently edit either external repository.

## Review checklist

- The change has focused tests and preserves existing behavior where the
  contract requires compatibility.
- User-visible messages avoid personal information and use type-appropriate
  registration calls to action.
- Secrets are supplied through environment variables and are never logged or
  committed.
- New configuration is validated in src/config/env.ts and documented in
  .env.example, README.md and DEPLOYMENT.md.
- npm run validate passes from a clean checkout.
- Docker changes retain the unprivileged, read-only and capability-dropping
  runtime defaults unless an operational need is documented.

Use focused branches such as feat/..., fix/... or docs/..., and describe the
behavior change and validation in the commit or pull request.
