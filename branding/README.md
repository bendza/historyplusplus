# history++ brand

- **Mark:** a woven infinity ("kept forever") in white on an indigo tile.
  - `icon.svg` is the master for 32 px and up.
  - `icon-small.svg` is the 16 px toolbar version, with a heavier line and a wider weave gap.
- **Colours** (app tokens in `src/ui/tokens.css`):

  | Role | Light | Dark |
  |---|---|---|
  | Accent | `#8f97ff` | `#8f97ff` |
  | Deep (text, links, focus, tile) | `#3a3fae` | `#b2b8ff` |
  | Tint | `#eceeff` | `#262a5c` |
  | Ink on accent | `#14165a` | `#14165a` |

  bookmark++ is the teal sibling: same font (Figtree), layout and style, its own colour.
- **Wordmark:** lowercase `history++`, Figtree bold, deep indigo.

## Files
- `public/icon/{16,32,48,128}.png`: extension and toolbar icons. The 128 px icon keeps its artwork inside 96 px with a 16 px transparent margin, per Chrome Web Store guidelines.
- `store/`: Chrome Web Store assets.
  - `icon-128.png`
  - `promo-small-440x280.png`
  - `marquee-1400x560.png`
  - `screenshot-*.png` (1280×800, sample data)

Regenerate the PNGs after editing the SVGs:

```
node branding/render-icons.cjs
```

This needs Playwright.
