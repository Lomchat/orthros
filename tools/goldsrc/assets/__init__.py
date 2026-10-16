"""Orthros GoldSrc asset toolchain (written from scratch, numpy + Pillow only).

Modules:
  xform    rotation math matching the GoldSrc studio code (AngleQuaternion, QuaternionMatrix, slerp)
  mdl      studio model (MDL v10, IDST) writer, reader/validator and exact animation decoding
  sdf      signed-distance-field primitives, combinators and domain transforms
  mesh     SDF meshing (surface nets), welding, smoothing, quadric decimation, crease normals
  rig      skeleton, posing, IK, keyframes, gait / breathing / secondary motion, sequence assembly
  texture  paint helpers (spots, gradients, eyes, AO, toon shading), UV charts + atlas packing,
           rasterising paint into the atlas, 256-colour quantisation
  builder  ModelBuilder: parts (SDF + bone + paint) -> complete mdl.Studio
  render   offline software renderer of .mdl bytes to PNG (single view or contact sheet)
  spr      sprite (IDSP v2) writer/reader
  wav      PCM WAV writer and a small synthesis kit
  icons    antialiased vector painter for HUD icons / sprite frames
  build    collects pokemon/*.py modules into a deterministic .pk3 (zip)

See README.md for the APIs.
"""
