---
name: Codex Switch Helper Design System
version: 1
colors:
  background: '#edf3f8'
  panel: 'rgba(255, 255, 255, 0.82)'
  panelStrong: '#ffffff'
  text: '#243044'
  muted: '#718096'
  line: 'rgba(148, 163, 184, 0.26)'
  primary: '#2478ff'
  success: '#12b981'
  danger: '#ef5350'
typography:
  family: 'Inter, system UI, Segoe UI, Microsoft YaHei, sans-serif'
  headingWeight: 850
  bodyWeight: 650
radius:
  control: 12
  card: 18
  shell: 24
spacing:
  page: 28
  panel: 16
  gap: 16
components:
  button: compact rounded action control
  panel: translucent workspace surface
  card: repeated profile or stat item only
---

# Design Intent

Codex Switch Helper is a Windows desktop utility for switching Codex Profiles. The UI should feel like a calm control panel: compact, readable, and direct. It is not a marketing page.

## Visual Language

Use a light blue-gray app background, translucent white panels, restrained borders, and blue as the main action color. Green is reserved for positive system state, red only for destructive actions. Avoid adding new dominant color families unless a feature needs clear semantic separation.

## Layout

The app uses a left rail plus a main workspace. Keep navigation short and icon-like. Main content should be organized as dashboard bands, profile lists, and one active work surface. Do not add landing-page hero sections.

## Components

Buttons are compact and action-focused. Primary actions use the existing blue gradient. Secondary actions stay white with a subtle border. Danger buttons use a pale red background and red text. Cards are for repeated items such as profiles, stats, and facts; do not nest cards inside cards.

## Typography

Use small, dense headings inside panels. Avoid oversized display type in operational screens. Paths, environment variables, command names, AppIDs, and file names use monospace formatting.

## Interaction

Confirm actions that change user-level environment variables, launch Codex with modified state, delete Profile data, install updates, or overwrite saved settings. Keep confirmation copy specific about what will change.

## Responsive Rules

At narrow widths, collapse grids to one column and stack button groups. Text in cards and paths must wrap or truncate without overlapping controls.
