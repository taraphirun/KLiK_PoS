# Phase 7: Keyboard Navigation & UI Usability
**Module 8**

**Status:** 🔷 In progress (partial — grid nav + quantity dialog deferred until live testing)

## Objective
Improve POS usability with global keyboard shortcuts and UI refinements for search and order summary.

## Scope note (2026-07-30)
Done now: Cmd/Ctrl+F search focus, scoped Escape-to-clear, and the `custom_invoice_ref` input.
Deferred: ArrowUp/ArrowDown product-grid navigation and Shift+Enter quantity dialog — these require
genuinely new functionality (no highlighted-item state or quantity-dialog component exists yet),
and the user couldn't test live this session, so building blind was judged too risky. Revisit once
live testing is possible. See `todo/016.md` and `todo/017.md` for the exact split.

## Todos
- [ ] [016.md](../todo/016.md): Frontend layout global shortcuts implementation (partial)
- [ ] [017.md](../todo/017.md): Frontend search bar and order summary refinements (partial)
