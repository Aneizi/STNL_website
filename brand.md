# Brand — Superteam Netherlands

_Status: active_

Superteam NL is the Dutch chapter of Solana's global builder network — a community of
builders, creatives and operators that create winning products and services within the
ecosystem.

## Direction: Editorial split

Warm Dutch editorial. Cream paper, ink type, one orange signal, hand-drawn canal
illustrations. Serif display headlines with sans body — the site should feel like a
beautifully set magazine spread about a real community, not a crypto landing page.

Source of truth: the Claude Design project "Superteam NL hero landing page"
(`d3060849-a84b-45ab-9ff9-0bfe7c7bc2f5`) — Hero / About / Events option files are
**hifi and final**. Recreate pixel-perfectly; do not invent new visual directions.

## Palette

| Token | Hex | Role |
|---|---|---|
| Cream | `#FBF7F0` | Page background |
| Ink | `#16130F` | Text, dark surfaces (tooltips), heavy rules |
| Orange | `#EE5B23` | Brand accent: active nav, highlighted words, links |
| Orange deep | `#D14E16` | Link hover |
| Muted | `#57534A` | Secondary/body text |
| Faded | `#B4AC9D` | Tertiary: slashes, list numbers, photo placeholder `#EFE9DE` |
| Line | `rgba(22,19,15,.15)` | Hairline rules (heavy rule = 2px Ink) |

Defined as CSS variables + Tailwind theme tokens in `app/globals.css`
(`bg-cream`, `text-ink`, `text-orange`, `text-muted`, `text-faded`, `border-line`).

## Typography

Loaded via `next/font/google` in `app/layout.tsx`:

- **Archivo** (variable) — UI and body. Wordmark 700, nav 600/12–13px uppercase
  +0.14em tracking, body 400/14.5–16px.
- **Instrument Serif** (400, normal + italic) — display headlines (52–76px, lh ≈1.04–1.08,
  -0.01em tracking) and editorial numerals/titles. Accent words italic + orange.

## Voice

Plainspoken, warm, a little playful ("Many variations, all very fun."). Dutch words used
as texture (*gezellig*) with definitions offered on hover. Lead with concrete actions:
Build / Gather / Earn.

## Motion

Crisp and small: 0.2s color transitions, 0.2s tooltip fade+lift, springy
`cubic-bezier(.34,1.56,.64,1)` only for playful stacks (hero polaroids). Respect
`prefers-reduced-motion` (global rule in `globals.css`).

## Assets

`public/landing/` — `st-orange.png` (logo mark, **do not alter**), `canal-wide.png`
(About illustration; watermarked stock preview awaiting licensed art), meetup photos.
