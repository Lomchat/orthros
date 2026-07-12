# Adding a post-process effect

Post-FX run at **present time** (after the game frame is drawn, after GDI/video/stats
compositing for the built-ins). Each effect is one fragment-shader pass. The chain wires
the bind group, manages ping-pong render targets, and gates broken shaders — you write
only the WGSL math.

The default chain is `[color-grade]`, a single pass that is byte-identical to the legacy
present when all quality settings are neutral. Every effect you enable adds exactly one
pass; intermediate textures are allocated lazily only when the chain is longer than one pass.

## Add an effect in 4 steps

1. **Copy a template.** `effects/scanlines.ts` (minimal, no uniforms) or `effects/crt.ts`
   (curvature + per-frame uniforms). Rename the class + `id`.

2. **Add a config toggle.** Add a field to `QualityConfig` in
   `src/worker/core/quality-config.ts` (+ a default in `DEFAULT_QUALITY`, + validation in
   `mergeQuality`). Read it in your effect's `enabled(q)`.

3. **Register it.** Import your effect in `registry.ts` and insert it in the `REGISTRY`
   array. Order = chain order; the **last active effect** does the present scaling, so put
   purely-cosmetic effects *before* `color-grade`.

4. **Test.** `dbg.quality({ myeffect: true })` in the worker console, then the
   screenshot A/B loop. No backend edits.

## The standard bind group (always available in your `fragmentSource()`)

The chain prepends `POSTFX_WGSL_PRELUDE`, so you can use:

```wgsl
struct VSOut { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@group(0) @binding(0) var inputTex: texture_2d<f32>;       // previous pass / source frame
@group(0) @binding(1) var inputSampler: sampler;            // linear, clamp-to-edge
@group(0) @binding(2) var<uniform> uCommon: CommonUniforms; // resolution / texel / time / frame / outputAspect
```

`CommonUniforms` = `{ resolution: vec2f, texel: vec2f, time: f32, frame: f32, outputAspect: f32 }`.
Refer to it as `uCommon` — **`common` is a reserved WGSL keyword** and naming the var `common` makes
every postfx shader fail to compile (invalid pipeline → black present).

Your entry point **must** be `fn fs_main(in: VSOut) -> @location(0) vec4f`.

## Per-frame uniforms (optional)

Set `uniformSize` to the byte size of your private struct (rounded up to 16) and declare it
yourself at binding 3:

```wgsl
struct MyParams { strength: f32, _pad: vec3f }
@group(0) @binding(3) var<uniform> params: MyParams;
```

Fill it each frame in `writeUniforms(dv, ctx)` using the `PostFrameContext`. **Never use
`Date.now()` / `Math.random()`** — read `ctx.time` / `ctx.frame` (the chain injects them).

## Rules

- One file per effect, under `effects/`. No edits to `presenter.ts`, `webgpu-backend.ts`,
  or the per-API backends.
- Effects must be **off by default** (`enabled` returns false for `DEFAULT_QUALITY`).
- A shader compile error can't black-screen: the chain falls back to passthrough for an
  effect until its `getCompilationInfo()` confirms a clean compile.
- Effects that need linearized depth (SSAO/DoF) are a **later, separate** mid-pipeline
  injection point — not this present-time chain.
