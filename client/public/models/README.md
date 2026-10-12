# Homepage 3D model — InstaSMM "Digital Growth Core"

The homepage hero shows `instasmm-growth-core.glb`, an original product model for
InstaSMM. It is not a character and it is not a third-party asset. It contains:

- an emerald growth core with a transparent glass shell,
- three tilted orbit rings in brushed steel (social platforms and automated delivery),
- eight turquoise nodes on steel struts linking the rings to the core,
- a graphite plinth.

## Provenance

- Modelled in SketchUp through the Trimble SketchUp connector (Python `build_model`
  script, inches, Z-up).
- The connector has no glTF export, and its saved `.skp` file could not be fetched
  from the build sandbox. So the GLB was produced from the live SketchUp session:
  the script read each group's and instance's world transform and deduplicated
  triangle mesh, and a small converter wrote the binary glTF 2.0 file.
  - Converter: Z-up inches → Y-up metres, smooth normals from area-weighted face
    normals, one mesh per object, one PBR material per SketchUp colour.
- Stats: 22 meshes, 6 materials, about 9.4k triangles, about 243 KB.

## Using a different model

- Set `VITE_HERO_MODEL_URL` at build time to any reachable glTF/GLB URL, or replace
  this file keeping the same name. The scene centres whatever it loads.
- Keep models under about 8 MB and about 150k triangles for mid-range Android phones.

## Fallbacks (visitors never see developer notes)

- WebGL unavailable, `prefers-reduced-motion`, or the "Disable 3D" toggle: a static
  emblem, with the rest of the page unchanged.
- Model fails to load: the static emblem plus a short visitor-facing line.
- The 3D view starts with the toggle state; dragging horizontally turns the model,
  and vertical swipes still scroll the page.
