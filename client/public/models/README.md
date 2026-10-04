# 3D character models (InstaSMM hero)

The homepage hero is built for an interactive 3D character, but **no model is
bundled with this repository**. Jujutsu Kaisen characters (Satoru Gojo, Yuji
Itadori, Ryomen Sukuna, Megumi Fushiguro) are copyrighted by Shueisha / MAPPA /
Gege Akutami. A downloadable fan model is NOT authorization for commercial use —
using one on this commercial SMM site would be copyright infringement.

## What to supply

1. Obtain a **written, commercial web-use license** for the character model from
   the rights holder or an authorized licensor (or use a model whose license
   explicitly permits commercial websites).
2. Place the file at `client/public/models/gojo.glb` (glTF 2.0 binary, `.glb`
   preferred), or set `VITE_HERO_MODEL_URL` at build time to any reachable URL.
3. Keep the license text in this folder (e.g. `LICENSE-gojo.txt`).

## Model requirements

- Format: `.glb` / `.gltf` (binary glTF 2.0), rigged, textures embedded.
- Size guidance: < 8 MB, < ~150k triangles, textures 1024–2048 px.
- Do NOT modify, repaint, restyle or face-swap the model — the scene renders
  the original appearance untouched.
- If the model carries its own idle animation it is played automatically;
  otherwise only camera/lighting motion is used.

## Current behavior (until a licensed model is supplied)

- The scene renders an abstract placeholder ring (not a character).
- If the model file is missing or fails to load, the placeholder stays and a
  caption explains it — the rest of the site is unaffected.
- WebGL-unavailable browsers and `prefers-reduced-motion` users get a static,
  fully functional page, plus a "Disable 3D" toggle on the hero.
