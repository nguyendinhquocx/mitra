# Surface brief: CalendarX Minimalist

## Direction contract

- Scope/mode: Calendar application shell, calendar view, share dialog, and event-share entry; Operate.
- Thesis: the calendar is white paper with time and events doing the visual work; controls recede unless they change state.
- Audience/job: the owner scans and plans events; a guest opens a bounded share link and edits only the selected shared calendar.
- First viewport: preserve the user's saved sidebar state; show the current date range and calendar grid immediately; keep create/share actions compact; remove build-version diagnostics from the work area.
- Product proof: render actual selected calendar data, not demo cards or marketing copy.
- Visual grammar: `#fff` canvas, `#111` primary text, `#666` secondary/muted text (meets 4.5:1 on white), `#999` only for non-text muted icons/gridlines, `#f6f6f6` selected surface, `#f0f0f0` hover; gridlines stay hairline-light; event cards are neutral with a narrow source-color marker.
- Signature interaction: one share surface selects target and view/edit role, toggles read-only owner-calendar overlays, then copies or revokes a link; event URL opens at that event while permission remains calendar-scoped.
- Assets/cost: code-led; use the requested Material Symbols calendar icon; no generated imagery or paid assets.
- Risk/trade-off: all holders of an edit URL are anonymous editors; revocation is available but cannot identify the human. A selected existing Google calendar is fully inside that link's scope.
- Finish conditions: preserve same-browser sidebar state, protect hidden owner calendars server-side, verify desktop/mobile layout and keyboard/touch states, and keep existing dark/system choices functional.
