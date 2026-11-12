# Natural companions

Approved looks: Dumbo (`pebble`), Reef (`ribbon`), Inky (`ink`). Saved IDs and the
five color IDs are unchanged. Artwork is original procedural Blender geometry
and materials. Reference photographs are not redistributed. Product icons stay
the existing minimal white octopus mark.

The two Python scripts are versioned copies of the website art source. Run them
in the website checkout under `design/2026-11-natural-companions/`:

```sh
blender --background --threads 12 --python design/2026-11-natural-companions/build-natural.py
blender --background --threads 12 --python design/2026-11-natural-companions/build-app-assets.py
```

The first saves `.blend` scenes, GLBs and 1200px gallery images. The second loads
those scenes and renders all fifteen account choices at 512px. Encode its PNGs
as WebP at quality 90, then copy identical bytes to `web/public/companions/` and
the mobile checkout's `assets/companions/`. Each filename is `<form>-<color>.webp`.
Both clients bundle the images, so displaying an avatar needs no remote image
service, model call or downloaded GLB. The source archive and gallery are at
https://octipus.cc/design-examples/companions/.

Web `identity.spec.ts` loads all fifteen choices; mobile widget tests decode
every asset. API and widget regressions cover saved preferences, unsaved drafts,
serialized saves, late reads and account changes. Phone refreshes occur on login,
opening Settings and returning to foreground. A foreground phone does not poll
the persona API continuously for edits made elsewhere.
