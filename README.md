# Portfolio Website

Personal portfolio of Qiang Luo (ktr0a): [qluo.dev](https://qluo.dev).

On every load the page is **rebuilt live by agents**: a swarm of cursor "agents" boots around the logo,
scatters, and builds each element in front of you (wireframes with size pills, placeholders, typed text,
clone-then-edit, QA passes, rulers and guides) while the camera tours the page, all with procedural sound
effects. The HUD at the bottom offers Tour / speed (1x, 2x, 4x) / sound / skip / Go live / Replay.

Still fully static: vanilla ES modules, no build step. GitHub repos load client-side; YouTube stats come
from a small Vercel function.

## Structure

| Path | What |
|---|---|
| `index.html` | Content, annotated for the build (`data-layer`, `data-clone`, `data-section`, `data-qa`) |
| `style.css` | Site styles |
| `css/build.css` | Build overlay, logo and HUD styles |
| `js/main.js` | Boot, toggles, Lenis smooth scroll, anchors, cursor, wiring |
| `js/data.js` | Email, GitHub repos, YouTube stats |
| `js/build/` | The build engine: `director` (planning and timeline), `agents`, `overlay` (canvas drawing), `typer`, `hud` |
| `js/sfx.js` | Procedural WebAudio sound effects and the ambient bed |
| `js/hero3d.js` | three.js hero object (bloom, environment lighting), with a CSS fallback |
| `assets/` | Favicon, OG image, project visuals (animated SVGs; `#still` freezes them) |
| `api/youtube.js` | Vercel function: channel statistics (needs `YT_API_KEY`) |

## Run locally

```sh
python -m http.server 4173
# open http://127.0.0.1:4173/
```

The YouTube function only runs on Vercel (`vercel dev` on port 3000 also works); elsewhere the stats keep
their static fallback values.

## Controls

- **Esc** skips the build, **R** replays it, **M** toggles sound, **T** toggles the camera tour.
- The nav has sound and animation toggles plus a **Rebuild** button. Animations stay on regardless of the
  OS reduced-motion setting; the toggle turns them off (saved in `localStorage` as `ktr0a:anim`).
- Without JavaScript, or with animations off, the page renders immediately as plain content.
