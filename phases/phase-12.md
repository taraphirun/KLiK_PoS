# Phase 12: Live Delivery Map
**Module 13**

**Status:** ⬜ Not started

## Objective
Port the bot frontend's `/live` map dashboard into KlikPOS: a real-time map plotting delivery GPS
points (and drivers), driven by Frappe realtime instead of the bot's socket.io/NestJS.

## Scope
- Google Maps view (the bot uses `@vis.gl/react-google-maps`) plotting each delivery's
  `gps_latitude/longitude`, colored by `completion_status` / `reconciliation_status`.
- Live updates: when a Delivery Report is ingested or reconciled, the map updates without refresh.
- Click a pin → the delivery detail / reconciliation actions (reuse Phase 9/11 components).

## Todos
- [ ] [031.md](../todo/031.md): Realtime delivery events (Frappe `publish_realtime`)
- [ ] [032.md](../todo/032.md): Live map page in KlikPOS

## Notes
- Replaces the bot's socket.io channel with Frappe's built-in realtime (`frappe.publish_realtime`
  + the SPA's socket client). No NestJS/Redis pub-sub needed.
- Google Maps API key handling should follow KlikPOS config conventions (POS Profile / site
  config), not be hard-coded.
