# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Primary: the owner uses a self-hosted calendar and planner to manage personal and work events.
- Guests: people who receive an owner-issued share link; they do not create accounts, and the link does not verify their real identity.

## Product Purpose

CalendarX brings the owner's existing calendars and local planning into one place, while allowing selected collaborators to work on a bounded shared calendar without account signup.

## Positioning

A self-hosted calendar whose owner controls Google sync and the scope of each collaboration link. A link is a revocable bearer capability, not proof of who is holding it.

## Operating Context

- Owner uses the web/PWA at `calendar.quoc.app`, with Google Calendar connected.
- Guests open a shared calendar or event-focused link in a browser without signing in.
- The main daily job is scanning and editing the current calendar view; sharing is an occasional secondary action.

## Capabilities and Constraints

- Inherited Mitra capabilities include events/tasks, multiple calendar views, local calendars, and Google/CalDAV integrations.
- A share link selects one data target: a dedicated Google calendar by default, an existing Google calendar, or CalendarX-only storage.
- Owner calendars outside the selected share target may be included as read-only overlays; they are hidden by default and must not be returned to a guest when hidden.
- Edit links grant CRUD only within the selected shared calendar. Event links deep-link to an event but use the shared-calendar permission scope.
- Google OAuth credentials stay server-side. Guests have no verified identity; revocation stops future access.

## Brand Commitments

- User-facing name: `CalendarX`.
- App/tab icon: Material Symbols `calendar_month`.
- Default UI direction: white-first, black/gray, low-chrome Minimalist; event source identity remains a thin color marker.

## Evidence on Hand

- Owner screenshots: current Calendar week view and sidebar, 2026-11-10.
- Owner decisions: no-login revocable links; target choices above; event link edit scope is the shared calendar; owner-calendar overlays are optional; event cards use neutral surfaces with a thin source marker.
- Source baseline: owner fork branch `uat/vi-calendar-2026-11-06`, commit `e2a074563f00ffbb2cd154d76cc67892c754c37d`.

## Product Principles

- Default to hiding personal schedules from link guests.
- One share link has one explicit calendar target and one role.
- Guests can edit shared data without exposing the owner's OAuth credential or account settings.
- Keep calendar scanning fast; visual color survives only when it carries source meaning.
