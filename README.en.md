# Huawei Talent Auto Player

> A Tampermonkey userscript for Huawei Talent online courses
> (`e.huawei.com/cn/talent`). Auto playback speed, mute, autoplay, and automatic
> "next lesson" — with a compact floating control panel.

![version](https://img.shields.io/badge/version-2.1.1-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-Chrome%20%2B%20Tampermonkey-lightgrey)

[中文说明](README.md) · [Changelog](CHANGELOG.md)

---

## Features

- Detects the player even when it lives in a **cross-origin iframe**
  (`talent.shixizhi.huawei.com`)
- Playback rate 0.5x–3x, persisted across sessions
- Volume control; 0% auto-mutes so the browser autoplay policy allows playback
- Autoplay with clear feedback when Chrome blocks it
- Listens for the real `ended` event and clicks the site's own "next lesson" button
- Re-applies rate/volume after each lesson switch
- SPA-friendly (hashchange + route polling + MutationObserver)
- Re-binds automatically when the player element is replaced
- Draggable, collapsible panel isolated in Shadow DOM
- Pause / resume auto-advance; full stop restores the original playback settings
- Logs from the iframe are forwarded to the main panel; one-click diagnostics

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the raw file URL:

```
https://raw.githubusercontent.com/efoolbug/huawei-talent-auto/main/huawei-talent-auto.user.js
```

3. Open `https://e.huawei.com/cn/talent/outPage/#/sxz-course/home` — the panel appears
   in the top-right corner.

## How it works

The course page is a top document plus a cross-origin iframe. The script runs in
both frames: the top frame owns the UI, settings and logs; the iframe owns the
actual `<video>` and the native "next lesson" button. They talk over `postMessage`.

Design rules (learned the hard way — see the 1.0.0 incident):

1. **Never write to the DOM inside a MutationObserver callback**
2. Keep the panel inside a **Shadow DOM** so its updates are invisible to the observer
3. **Never patch native prototypes** — set properties on the `<video>` instance only

Next-lesson navigation uses a one-shot lock plus navigation confirmation, with at
most one retry and a 30-second cooldown.

## FAQ

- **Blank page** — a 1.0.0 bug (mutation-observer feedback loop). Upgrade to 2.1.0.
- **"No video player found"** — the lesson may be text/slides, or the player is in an
  iframe on a domain the script is not allowed to touch. Press "Diagnostics" and add
  the domain to `@match` if needed.
- **No autoplay after a refresh** — Chrome's autoplay policy for cross-origin iframes.
  Click the video once; the panel tells you when this happens.
- **Progress tracking** — the script plays the real video at a higher rate; it does not
  fake watch time. In testing (2026-11-26) 2x playback was accepted by the platform.

## Disclaimer

Personal/educational automation tool. Not affiliated with, authorized by, or endorsed
by Huawei. Use at your own risk and comply with your platform's terms of service.
No capability to forge watch time, completion status, or bypass assessments is provided.

## License

[MIT](LICENSE)
