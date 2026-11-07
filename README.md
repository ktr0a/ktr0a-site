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
| `style.css` | Site styles, including the liquid-glass material (`.glass`, `--glass-*` tokens) for floating chrome |
| `css/build.css` | Build overlay, logo, HUD and settings-panel styles |
| `js/main.js` | Boot, toggles, first/return-visit logic, Lenis smooth scroll, anchors, wiring |
| `js/settings.js` | Settings gear and popover (speed and autoscroll on return visits) |
| `js/cursor.js` | Native CSS cursor (the agents' arrow) plus the trailing "you" tag |
| `js/data.js` | Email, GitHub repos, YouTube stats |
| `js/build/` | The build engine: `director` (planning and timeline), `agents`, `overlay` (canvas drawing), `typer`, `hud` |
| `js/sfx.js` | Procedural WebAudio sound effects and the ambient bed |
| `js/herograph.js` | Hero "vault map" (Canvas 2D): the study system as an animated graph that agent cursors keep filing notes into |
| `assets/` | Favicon, OG image, project screenshots (`assets/shots/`) |
| `api/youtube.js` | Vercel function: channel statistics (needs `YT_API_KEY`) |

## Run locally

```sh
python -m http.server 4173
# open http://127.0.0.1:4173/
```

The YouTube function only runs on Vercel (`vercel dev` on port 3000 also works); elsewhere the stats keep
their static fallback values.

## Behaviour

- **First visit:** a start screen: the logo breathes while a see-through ring of agent cursors circles
  it, waiting, and "Click anywhere to start" fades in below. The click presses the logo, the ring lights
  up and becomes the boot swarm, and the full build plays at 1x with the camera tour on, with sound from
  the first beat (that click is the gesture browsers require before they allow audio). Esc skips
  straight to the page.
- **Return visits:** no start screen; 2x with the tour off by default. Visitors can change both in the
  settings gear (`ktr0a:returnSpeed`, `ktr0a:returnTour`), or turn on **Full build every visit**
  (`ktr0a:alwaysFull`) to get the start screen and the full build every time.
- **Rebuild** (nav), **Replay** (HUD) and **R** go back to the start screen and play the full build at
  1x with the tour on.
- **Go live** (HUD, after the build) closes the HUD and scrolls back to the top of the finished page.
- **Hero map:** an animated map of Uni OS; it grows in when the build reveals it (a short grow after a
  skip) and shows one still frame with animations off.
- **Sound** is on by default. On a return visit it starts on the first click, tap or key press.
- **Cursor:** on mouse and trackpad devices the arrow is a native CSS cursor (no lag); only the small "you"
  tag is moved by script and trails slightly. High-contrast (forced-colors) mode keeps the system cursor.

## Controls

- **Esc** skips the build (also from the start screen), **R** replays it, **M** toggles sound, **T** toggles
  the camera tour.
- The nav has sound and animation toggles, the settings gear and a **Rebuild** button. Animations stay on
  regardless of the OS reduced-motion setting; the toggle turns them off (saved in `localStorage` as
  `ktr0a:anim`).
- Without JavaScript, or with animations off, the page renders immediately as plain content.
