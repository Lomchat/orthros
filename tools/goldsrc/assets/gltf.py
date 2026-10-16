"""glTF 2.0 reader (written from scratch: Python stdlib + numpy + Pillow).

Reads binary .glb files (JSON chunk + BIN chunk) and .gltf JSON files (buffers as data: URIs or files next to
the .gltf).  Covers what skinned, animated character models use:

  * accessors: every component type, `normalized` integers, byteStride, sparse substitution, min/max ignored
  * nodes: TRS or matrix, hierarchy, scenes; world matrices for the default pose or any animation time
  * meshes / primitives: attributes (POSITION, NORMAL, TEXCOORD_n, JOINTS_n, WEIGHTS_n, COLOR_0), indices,
    modes TRIANGLES / TRIANGLE_STRIP / TRIANGLE_FAN (converted to a triangle list), material
  * skins: joints, inverseBindMatrices (identity when absent), skeleton
  * materials: baseColorFactor, baseColorTexture (+ texCoord, KHR_texture_transform), alphaMode / alphaCutoff,
    doubleSided, KHR_materials_unlit
  * textures / images: source or EXT_texture_webp / KHR_texture_basisu-free fallbacks, decoded with Pillow
  * animations: samplers LINEAR / STEP / CUBICSPLINE, channels translation / rotation / scale ("weights"
    channels are parsed and ignored by the pose evaluation)

Untrusted input: everything is bounds-checked and raises GltfError; nothing is executed.

    g = gltf.load("model.glb")
    G = g.world_matrices()                     # (num_nodes, 4, 4) default pose
    G = g.world_matrices(g.animations[0], 0.5) # pose at t = 0.5 s of animation 0
    for node, prim in g.mesh_instances():      # mesh nodes of the default scene with their primitives
        prim.attributes["POSITION"], prim.triangles, prim.material
"""
import base64
import io
import json
import math
import os
import struct
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np

GLB_MAGIC = 0x46546C67  # "glTF"
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

_COMPONENT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
_NORM_DIV = {5120: 127.0, 5121: 255.0, 5122: 32767.0, 5123: 65535.0, 5125: 4294967295.0}


class GltfError(ValueError):
    """Malformed or unsupported glTF data."""


# ----------------------------------------------------------------------------------------------
# math helpers (quaternions are (x, y, z, w) as in glTF)
# ----------------------------------------------------------------------------------------------

def quat_matrix(q):
    """(..., 4) unit quaternions (x, y, z, w) -> (..., 3, 3) rotation matrices."""
    q = np.asarray(q, dtype=np.float64)
    n = np.linalg.norm(q, axis=-1, keepdims=True)
    q = q / np.where(n > 1e-12, n, 1.0)
    x, y, z, w = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    m = np.empty(q.shape[:-1] + (3, 3))
    m[..., 0, 0] = 1 - 2 * (y * y + z * z)
    m[..., 0, 1] = 2 * (x * y - z * w)
    m[..., 0, 2] = 2 * (x * z + y * w)
    m[..., 1, 0] = 2 * (x * y + z * w)
    m[..., 1, 1] = 1 - 2 * (x * x + z * z)
    m[..., 1, 2] = 2 * (y * z - x * w)
    m[..., 2, 0] = 2 * (x * z - y * w)
    m[..., 2, 1] = 2 * (y * z + x * w)
    m[..., 2, 2] = 1 - 2 * (x * x + y * y)
    return m


def matrix_quat(m):
    """3x3 rotation matrix -> unit quaternion (x, y, z, w)."""
    m = np.asarray(m, dtype=np.float64)
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def slerp(a, b, t):
    """Shortest-path spherical interpolation of quaternions (x, y, z, w), arrays (..., 4), t scalar or (...)."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    t = np.asarray(t, dtype=np.float64)
    d = np.sum(a * b, axis=-1)
    b = np.where((d < 0)[..., None], -b, b)
    d = np.abs(d)
    lin = d > 0.9995
    th = np.arccos(np.clip(d, -1.0, 1.0))
    s = np.sin(th)
    s = np.where(lin, 1.0, s)
    wa = np.where(lin, 1.0 - t, np.sin((1.0 - t) * th) / s)
    wb = np.where(lin, t, np.sin(t * th) / s)
    q = wa[..., None] * a + wb[..., None] * b
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def trs_matrix(t, r, s):
    """4x4 from translation (3,), rotation quaternion (4,) and scale (3,): T * R * S."""
    m = np.eye(4)
    m[:3, :3] = quat_matrix(r) * np.asarray(s, dtype=np.float64)[None, :]
    m[:3, 3] = t
    return m


def decompose(m):
    """4x4 (affine, no shear expected) -> (translation, quaternion, scale)."""
    m = np.asarray(m, dtype=np.float64)
    t = m[:3, 3].copy()
    a = m[:3, :3]
    s = np.linalg.norm(a, axis=0)
    r = a / np.where(s > 1e-12, s, 1.0)[None, :]
    if np.linalg.det(r) < 0:
        s[0] = -s[0]
        r[:, 0] = -r[:, 0]
    return t, matrix_quat(r), s


# ----------------------------------------------------------------------------------------------
# data model
# ----------------------------------------------------------------------------------------------

@dataclass
class Node:
    index: int
    name: str
    parent: int = -1
    children: List[int] = field(default_factory=list)
    translation: np.ndarray = None   # (3,)
    rotation: np.ndarray = None      # (4,) x y z w
    scale: np.ndarray = None         # (3,)
    matrix: Optional[np.ndarray] = None  # (4, 4) when given as a matrix (then TRS = its decomposition)
    mesh: int = -1
    skin: int = -1

    def local(self, t=None, r=None, s=None):
        """Local 4x4 matrix; t/r/s override the node's own TRS (animation)."""
        if self.matrix is not None and t is None and r is None and s is None:
            return self.matrix.copy()
        return trs_matrix(self.translation if t is None else t, self.rotation if r is None else r,
                          self.scale if s is None else s)


@dataclass
class Primitive:
    attributes: Dict[str, np.ndarray]   # POSITION (n, 3) float, NORMAL, TEXCOORD_0 (n, 2), JOINTS_0 (n, 4) int, ...
    triangles: np.ndarray               # (t, 3) int vertex indices, counter-clockwise front faces (glTF)
    material: int = -1
    mode: int = 4


@dataclass
class Mesh:
    name: str
    primitives: List[Primitive]


@dataclass
class Skin:
    name: str
    joints: List[int]                   # node indices
    inverse_bind: np.ndarray            # (J, 4, 4)
    skeleton: int = -1


@dataclass
class Material:
    name: str
    base_color: np.ndarray = field(default_factory=lambda: np.ones(4))   # RGBA factor (linear)
    base_texture: int = -1              # texture index
    texcoord: int = 0
    uv_transform: Optional[np.ndarray] = None   # 3x3 (KHR_texture_transform) applied to uv
    alpha_mode: str = "OPAQUE"          # OPAQUE | MASK | BLEND
    alpha_cutoff: float = 0.5
    double_sided: bool = False
    unlit: bool = False
    emissive: np.ndarray = field(default_factory=lambda: np.zeros(3))


@dataclass
class Sampler:
    input: np.ndarray                   # (k,) seconds, increasing
    output: np.ndarray                  # (k, c) or (3k, c) for CUBICSPLINE
    interpolation: str = "LINEAR"

    def evaluate(self, t, quaternion=False):
        """Value at time t (clamped to the key range)."""
        ts = self.input
        k = len(ts)
        cubic = self.interpolation == "CUBICSPLINE"
        vals = self.output.reshape(k, 3, -1)[:, 1] if cubic else self.output
        if k == 1 or t <= ts[0]:
            v = vals[0].copy()
        elif t >= ts[-1]:
            v = vals[-1].copy()
        else:
            i = int(np.searchsorted(ts, t, side="right")) - 1
            i = min(max(i, 0), k - 2)
            t0, t1 = ts[i], ts[i + 1]
            dt = t1 - t0
            u = 0.0 if dt <= 0 else (t - t0) / dt
            if self.interpolation == "STEP":
                v = vals[i].copy()
            elif cubic:
                o = self.output.reshape(k, 3, -1)
                p0, m0 = o[i, 1], o[i, 2] * dt     # value, out-tangent of key i
                p1, m1 = o[i + 1, 1], o[i + 1, 0] * dt  # value, in-tangent of key i+1
                u2, u3 = u * u, u * u * u
                v = (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1
            elif quaternion:
                v = slerp(vals[i], vals[i + 1], u)
            else:
                v = vals[i] * (1 - u) + vals[i + 1] * u
        if quaternion:
            n = np.linalg.norm(v)
            v = v / n if n > 1e-12 else np.array([0.0, 0.0, 0.0, 1.0])
        return np.asarray(v, dtype=np.float64)


@dataclass
class Channel:
    node: int
    path: str                           # translation | rotation | scale | weights
    sampler: int


@dataclass
class Animation:
    name: str
    channels: List[Channel]
    samplers: List[Sampler]

    @property
    def duration(self):
        return max((float(s.input[-1]) for s in self.samplers if len(s.input)), default=0.0)

    @property
    def start(self):
        return min((float(s.input[0]) for s in self.samplers if len(s.input)), default=0.0)

    def key_times(self):
        """Sorted union of all key times."""
        if not self.samplers:
            return np.zeros(1)
        return np.unique(np.concatenate([s.input for s in self.samplers]))

    def sample(self, t):
        """{node: {"translation": v, "rotation": q, "scale": s}} at time t (seconds)."""
        out = {}
        for c in self.channels:
            if c.path not in ("translation", "rotation", "scale"):
                continue
            out.setdefault(c.node, {})[c.path] = self.samplers[c.sampler].evaluate(t, quaternion=c.path == "rotation")
        return out


# ----------------------------------------------------------------------------------------------
# the document
# ----------------------------------------------------------------------------------------------

class GLTF:
    def __init__(self, doc, bin_chunk=None, base_dir=None):
        if not isinstance(doc, dict):
            raise GltfError("JSON root is not an object")
        ver = str(doc.get("asset", {}).get("version", ""))
        if not ver.startswith("2"):
            raise GltfError(f"unsupported glTF version {ver!r}")
        unsupported = set(doc.get("extensionsRequired", [])) - {"EXT_texture_webp", "KHR_materials_unlit",
                                                                   "KHR_texture_transform", "KHR_mesh_quantization"}
        if unsupported:
            raise GltfError(f"required extensions not supported: {sorted(unsupported)} (decode Draco/meshopt first)")
        self.json = doc
        self.base_dir = base_dir
        self._bin = bin_chunk
        self._buffers = {}
        self._accessor_cache = {}
        self.nodes = self._read_nodes()
        self.meshes = [self._read_mesh(i) for i in range(len(doc.get("meshes", [])))]
        self.skins = [self._read_skin(i) for i in range(len(doc.get("skins", [])))]
        self.materials = [self._read_material(i) for i in range(len(doc.get("materials", [])))]
        self.animations = [self._read_animation(i) for i in range(len(doc.get("animations", [])))]

    # raw data ---------------------------------------------------------------------------------
    def buffer(self, i):
        if i in self._buffers:
            return self._buffers[i]
        bufs = self.json.get("buffers", [])
        if not 0 <= i < len(bufs):
            raise GltfError(f"buffer {i} out of range")
        b = bufs[i]
        uri = b.get("uri")
        if uri is None:
            if self._bin is None or i != 0:
                raise GltfError(f"buffer {i} has no uri and no GLB BIN chunk")
            data = self._bin
        elif uri.startswith("data:"):
            try:
                data = base64.b64decode(uri.split(",", 1)[1])
            except Exception as e:  # noqa: BLE001
                raise GltfError(f"buffer {i}: bad data URI") from e
        else:
            if self.base_dir is None:
                raise GltfError(f"buffer {i}: external uri {uri!r} without a base directory")
            path = os.path.join(self.base_dir, os.path.basename(uri))  # never leaves the model's folder
            with open(path, "rb") as f:
                data = f.read()
        if len(data) < int(b.get("byteLength", 0)):
            raise GltfError(f"buffer {i}: {len(data)} bytes < byteLength {b.get('byteLength')}")
        self._buffers[i] = data
        return data

    def buffer_view(self, i):
        """(bytes object, offset, length, stride) of a bufferView."""
        bvs = self.json.get("bufferViews", [])
        if not 0 <= i < len(bvs):
            raise GltfError(f"bufferView {i} out of range")
        bv = bvs[i]
        data = self.buffer(int(bv["buffer"]))
        off = int(bv.get("byteOffset", 0))
        ln = int(bv["byteLength"])
        if off < 0 or ln < 0 or off + ln > len(data):
            raise GltfError(f"bufferView {i} outside its buffer")
        return data, off, ln, int(bv.get("byteStride", 0))

    def _read_typed(self, view, byte_offset, count, ctype, ncomp):
        dt = np.dtype(_COMPONENT[ctype]).newbyteorder("<")
        esize = dt.itemsize * ncomp
        data, off, ln, stride = self.buffer_view(view)
        stride = stride or esize
        start = off + byte_offset
        if count == 0:
            return np.zeros((0, ncomp), dt)
        need = (count - 1) * stride + esize
        if byte_offset < 0 or byte_offset + need > ln:
            raise GltfError(f"accessor data outside bufferView {view}")
        if stride == esize:
            return np.frombuffer(data, dt, count * ncomp, start).reshape(count, ncomp).copy()
        raw = np.frombuffer(data, np.uint8, need, start)
        out = np.empty((count, ncomp), dt)
        for i in range(count):
            out[i] = np.frombuffer(raw[i * stride:i * stride + esize].tobytes(), dt, ncomp)
        return out

    def accessor(self, i, as_float=None):
        """Accessor i as a numpy array (count, ncomp) (or (count,) for SCALAR, (count, 4, 4) for MAT4,
        column-major as glTF).  Normalized integers come back as floats; as_float=True forces floats."""
        key = (i, as_float)
        if key in self._accessor_cache:
            return self._accessor_cache[key]
        accs = self.json.get("accessors", [])
        if not 0 <= i < len(accs):
            raise GltfError(f"accessor {i} out of range")
        a = accs[i]
        ctype = int(a["componentType"])
        if ctype not in _COMPONENT:
            raise GltfError(f"accessor {i}: component type {ctype}")
        typ = a["type"]
        if typ not in _NCOMP:
            raise GltfError(f"accessor {i}: type {typ}")
        ncomp = _NCOMP[typ]
        count = int(a["count"])
        if count < 0 or count > 50_000_000:
            raise GltfError(f"accessor {i}: count {count}")
        if "bufferView" in a:
            arr = self._read_typed(int(a["bufferView"]), int(a.get("byteOffset", 0)), count, ctype, ncomp)
        else:
            arr = np.zeros((count, ncomp), _COMPONENT[ctype])
        sp = a.get("sparse")
        if sp:
            n = int(sp["count"])
            idx = self._read_typed(int(sp["indices"]["bufferView"]), int(sp["indices"].get("byteOffset", 0)), n,
                                   int(sp["indices"]["componentType"]), 1).reshape(-1).astype(np.int64)
            vals = self._read_typed(int(sp["values"]["bufferView"]), int(sp["values"].get("byteOffset", 0)), n,
                                    ctype, ncomp)
            if n and (idx.min() < 0 or idx.max() >= count):
                raise GltfError(f"accessor {i}: sparse index out of range")
            arr = arr.copy()
            arr[idx] = vals
        normalized = bool(a.get("normalized", False))
        if normalized and ctype != 5126:
            arr = np.maximum(arr.astype(np.float64) / _NORM_DIV[ctype], -1.0)
        elif ctype == 5126 or as_float:
            arr = arr.astype(np.float64)
        else:
            arr = arr.astype(np.int64)
        if typ == "SCALAR":
            arr = arr.reshape(-1)
        elif typ.startswith("MAT"):
            k = int(math.isqrt(ncomp))
            arr = arr.reshape(count, k, k).transpose(0, 2, 1)  # column-major on disk
        self._accessor_cache[key] = arr
        return arr

    # structure --------------------------------------------------------------------------------
    def _read_nodes(self):
        out = []
        raw = self.json.get("nodes", [])
        for i, n in enumerate(raw):
            node = Node(index=i, name=str(n.get("name", f"node{i}")), children=[int(c) for c in n.get("children", [])],
                        mesh=int(n.get("mesh", -1)), skin=int(n.get("skin", -1)))
            if "matrix" in n:
                m = np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
                node.matrix = m
                node.translation, node.rotation, node.scale = decompose(m)
            else:
                node.translation = np.array(n.get("translation", [0, 0, 0]), dtype=np.float64)
                node.rotation = np.array(n.get("rotation", [0, 0, 0, 1]), dtype=np.float64)
                node.scale = np.array(n.get("scale", [1, 1, 1]), dtype=np.float64)
            out.append(node)
        for n in out:
            for c in n.children:
                if not 0 <= c < len(out):
                    raise GltfError(f"node {n.index}: child {c} out of range")
                if out[c].parent != -1:
                    raise GltfError(f"node {c} has two parents")
                out[c].parent = n.index
        # cycle check
        for n in out:
            seen, p = 0, n.parent
            while p != -1:
                seen += 1
                if seen > len(out):
                    raise GltfError("node hierarchy has a cycle")
                p = out[p].parent
        return out

    def scene_roots(self, scene=None):
        scenes = self.json.get("scenes", [])
        if not scenes:
            return [n.index for n in self.nodes if n.parent == -1]
        si = self.json.get("scene", 0) if scene is None else scene
        return [int(x) for x in scenes[si].get("nodes", [])]

    def scene_nodes(self, scene=None):
        """All node indices reachable from the scene roots (depth-first, parents first)."""
        out = []
        stack = list(reversed(self.scene_roots(scene)))
        while stack:
            i = stack.pop()
            out.append(i)
            stack.extend(reversed(self.nodes[i].children))
        return out

    def _read_mesh(self, i):
        m = self.json["meshes"][i]
        prims = []
        for p in m.get("primitives", []):
            attrs = {}
            for name, acc in p.get("attributes", {}).items():
                attrs[name] = self.accessor(int(acc))
            if "POSITION" not in attrs:
                raise GltfError(f"mesh {i}: primitive without POSITION")
            nv = len(attrs["POSITION"])
            for name, a in attrs.items():
                if len(a) != nv:
                    raise GltfError(f"mesh {i}: attribute {name} has {len(a)} items, POSITION {nv}")
            mode = int(p.get("mode", 4))
            idx = self.accessor(int(p["indices"])).astype(np.int64) if "indices" in p else np.arange(nv)
            if len(idx) and (idx.min() < 0 or idx.max() >= nv):
                raise GltfError(f"mesh {i}: index out of range")
            if mode == 4:
                tris = idx[:len(idx) // 3 * 3].reshape(-1, 3)
            elif mode == 5:
                tris = np.array([(idx[k], idx[k + 1], idx[k + 2]) if k % 2 == 0 else (idx[k + 1], idx[k], idx[k + 2])
                                 for k in range(len(idx) - 2)], dtype=np.int64).reshape(-1, 3)
            elif mode == 6:
                tris = np.array([(idx[0], idx[k + 1], idx[k + 2]) for k in range(len(idx) - 2)],
                                dtype=np.int64).reshape(-1, 3)
            else:
                continue  # points / lines: not drawable as a studio model
            if len(tris):
                tris = tris[(tris[:, 0] != tris[:, 1]) & (tris[:, 1] != tris[:, 2]) & (tris[:, 0] != tris[:, 2])]
            prims.append(Primitive(attributes=attrs, triangles=tris, material=int(p.get("material", -1)), mode=mode))
        return Mesh(name=str(m.get("name", f"mesh{i}")), primitives=prims)

    def _read_skin(self, i):
        s = self.json["skins"][i]
        joints = [int(j) for j in s["joints"]]
        for j in joints:
            if not 0 <= j < len(self.nodes):
                raise GltfError(f"skin {i}: joint {j} out of range")
        if "inverseBindMatrices" in s:
            ibm = self.accessor(int(s["inverseBindMatrices"]))
            if ibm.shape != (len(joints), 4, 4):
                raise GltfError(f"skin {i}: inverseBindMatrices shape {ibm.shape}")
        else:
            ibm = np.tile(np.eye(4), (len(joints), 1, 1))
        return Skin(name=str(s.get("name", f"skin{i}")), joints=joints, inverse_bind=ibm,
                    skeleton=int(s.get("skeleton", -1)))

    def _read_material(self, i):
        m = self.json["materials"][i]
        pbr = m.get("pbrMetallicRoughness", {})
        mat = Material(name=str(m.get("name", f"material{i}")))
        mat.base_color = np.array(pbr.get("baseColorFactor", [1, 1, 1, 1]), dtype=np.float64)
        bct = pbr.get("baseColorTexture")
        if bct is not None:
            mat.base_texture = int(bct["index"])
            mat.texcoord = int(bct.get("texCoord", 0))
            tt = bct.get("extensions", {}).get("KHR_texture_transform")
            if tt:
                off = tt.get("offset", [0, 0])
                rot = float(tt.get("rotation", 0))
                sc = tt.get("scale", [1, 1])
                c, s = math.cos(rot), math.sin(rot)
                T = np.array([[1, 0, off[0]], [0, 1, off[1]], [0, 0, 1]], float)
                R = np.array([[c, s, 0], [-s, c, 0], [0, 0, 1]], float)
                S = np.array([[sc[0], 0, 0], [0, sc[1], 0], [0, 0, 1]], float)
                mat.uv_transform = T @ R @ S
                if "texCoord" in tt:
                    mat.texcoord = int(tt["texCoord"])
        mat.alpha_mode = str(m.get("alphaMode", "OPAQUE"))
        mat.alpha_cutoff = float(m.get("alphaCutoff", 0.5))
        mat.double_sided = bool(m.get("doubleSided", False))
        mat.unlit = "KHR_materials_unlit" in m.get("extensions", {})
        mat.emissive = np.array(m.get("emissiveFactor", [0, 0, 0]), dtype=np.float64)
        return mat

    def _read_animation(self, i):
        a = self.json["animations"][i]
        samplers = []
        for s in a.get("samplers", []):
            inp = self.accessor(int(s["input"]), as_float=True).reshape(-1)
            out = self.accessor(int(s["output"]), as_float=True)
            out = out.reshape(len(out), -1)
            interp = str(s.get("interpolation", "LINEAR"))
            if interp not in ("LINEAR", "STEP", "CUBICSPLINE"):
                raise GltfError(f"animation {i}: interpolation {interp}")
            if len(inp) and np.any(np.diff(inp) < 0):
                raise GltfError(f"animation {i}: key times not increasing")
            samplers.append(Sampler(input=inp, output=out, interpolation=interp))
        chans = []
        for c in a.get("channels", []):
            tgt = c.get("target", {})
            if "node" not in tgt:
                continue
            node, path, si = int(tgt["node"]), str(tgt["path"]), int(c["sampler"])
            if not 0 <= node < len(self.nodes) or not 0 <= si < len(samplers):
                raise GltfError(f"animation {i}: bad channel")
            s = samplers[si]
            k = len(s.input) * (3 if s.interpolation == "CUBICSPLINE" else 1)
            width = {"translation": 3, "rotation": 4, "scale": 3}.get(path)
            if width is not None:
                if s.output.shape[0] != k or s.output.shape[1] != width:
                    raise GltfError(f"animation {i}: channel {path} output shape {s.output.shape}")
            chans.append(Channel(node=node, path=path, sampler=si))
        return Animation(name=str(a.get("name", f"animation{i}")), channels=chans, samplers=samplers)

    # images -----------------------------------------------------------------------------------
    def texture_source(self, tex_index):
        texs = self.json.get("textures", [])
        if not 0 <= tex_index < len(texs):
            raise GltfError(f"texture {tex_index} out of range")
        t = texs[tex_index]
        src = t.get("source")
        ext = t.get("extensions", {})
        for name in ("EXT_texture_webp", "EXT_texture_avif", "MSFT_texture_dds"):
            if name in ext and "source" in ext[name]:
                src = ext[name]["source"]
                break
        if src is None:
            raise GltfError(f"texture {tex_index} has no usable source")
        return int(src)

    def image_bytes(self, image_index):
        ims = self.json.get("images", [])
        if not 0 <= image_index < len(ims):
            raise GltfError(f"image {image_index} out of range")
        im = ims[image_index]
        if "bufferView" in im:
            data, off, ln, _ = self.buffer_view(int(im["bufferView"]))
            return bytes(data[off:off + ln])
        uri = im.get("uri", "")
        if uri.startswith("data:"):
            return base64.b64decode(uri.split(",", 1)[1])
        if self.base_dir is None:
            raise GltfError(f"image {image_index}: external uri without a base directory")
        with open(os.path.join(self.base_dir, os.path.basename(uri)), "rb") as f:
            return f.read()

    def image(self, image_index):
        """Decoded PIL image (RGBA)."""
        from PIL import Image
        try:
            im = Image.open(io.BytesIO(self.image_bytes(image_index)))
            im.load()
        except Exception as e:  # noqa: BLE001
            raise GltfError(f"image {image_index}: cannot decode ({e})") from e
        return im.convert("RGBA")

    def texture_image(self, tex_index):
        return self.image(self.texture_source(tex_index))

    # posing -----------------------------------------------------------------------------------
    def world_matrices(self, animation=None, t=0.0, overrides=None):
        """(num_nodes, 4, 4) world matrices for the default pose, or animation (index or Animation) at t seconds.
        overrides: {node: {"translation"|"rotation"|"scale": value}} applied last."""
        if isinstance(animation, int):
            animation = self.animations[animation]
        sample = animation.sample(t) if animation is not None else {}
        if overrides:
            for k, v in overrides.items():
                sample.setdefault(k, {}).update(v)
        n = len(self.nodes)
        world = np.zeros((n, 4, 4))
        done = np.zeros(n, dtype=bool)
        order = []
        for i in range(n):  # parents first
            chain = []
            p = i
            while p != -1 and not done[p] and p not in chain:
                chain.append(p)
                p = self.nodes[p].parent
            for c in reversed(chain):
                if not done[c]:
                    done[c] = True
                    order.append(c)
        for i in order:
            nd = self.nodes[i]
            s = sample.get(i)
            loc = nd.local(**({"t": s.get("translation"), "r": s.get("rotation"), "s": s.get("scale")} if s else {}))
            world[i] = loc if nd.parent == -1 else world[nd.parent] @ loc
        return world

    def mesh_instances(self, scene=None):
        """[(node index, mesh index)] for every mesh node of the scene."""
        return [(i, self.nodes[i].mesh) for i in self.scene_nodes(scene) if self.nodes[i].mesh >= 0]

    def summary(self):
        lines = [f"glTF: {len(self.nodes)} nodes, {len(self.meshes)} meshes, {len(self.skins)} skins, "
                 f"{len(self.materials)} materials, {len(self.animations)} animations"]
        for ni, mi in self.mesh_instances():
            m = self.meshes[mi]
            for p in m.primitives:
                mat = self.materials[p.material].name if p.material >= 0 else "-"
                lines.append(f"  node {self.nodes[ni].name} mesh {m.name} skin {self.nodes[ni].skin}: "
                             f"{len(p.attributes['POSITION'])} verts {len(p.triangles)} tris, material {mat}, "
                             f"attributes {sorted(p.attributes)}")
        for si, s in enumerate(self.skins):
            lines.append(f"  skin {si}: {len(s.joints)} joints")
        for a in self.animations:
            lines.append(f"  animation {a.name}: {a.duration:.3f} s, {len(a.channels)} channels")
        return "\n".join(lines)


# ----------------------------------------------------------------------------------------------
# entry points
# ----------------------------------------------------------------------------------------------

def parse_glb(data):
    """Split GLB bytes into (json dict, bin bytes or None)."""
    if len(data) < 20:
        raise GltfError("file too short for a GLB")
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise GltfError("not a GLB (bad magic)")
    if version != 2:
        raise GltfError(f"GLB version {version}")
    if length > len(data):
        raise GltfError("GLB length beyond the file")
    off = 12
    doc, bin_chunk = None, None
    while off + 8 <= length:
        clen, ctype = struct.unpack_from("<II", data, off)
        off += 8
        if off + clen > length:
            raise GltfError("GLB chunk beyond the file")
        chunk = data[off:off + clen]
        if ctype == CHUNK_JSON and doc is None:
            try:
                doc = json.loads(chunk.decode("utf-8").rstrip(" \0"))
            except Exception as e:  # noqa: BLE001
                raise GltfError(f"bad JSON chunk: {e}") from e
        elif ctype == CHUNK_BIN and bin_chunk is None:
            bin_chunk = bytes(chunk)
        off += (clen + 3) & ~3
    if doc is None:
        raise GltfError("GLB without a JSON chunk")
    return doc, bin_chunk


def loads(data, base_dir=None):
    """GLTF from bytes (GLB or JSON text)."""
    data = bytes(data)
    if data[:4] == b"glTF":
        doc, b = parse_glb(data)
        return GLTF(doc, b, base_dir)
    try:
        doc = json.loads(data.decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        raise GltfError(f"neither GLB nor glTF JSON: {e}") from e
    return GLTF(doc, None, base_dir)


def load(path):
    with open(path, "rb") as f:
        data = f.read()
    return loads(data, os.path.dirname(os.path.abspath(path)))


def write_glb(doc, bin_chunk=b""):
    """Minimal GLB writer (tests): JSON dict + BIN bytes -> bytes."""
    j = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    j += b" " * ((4 - len(j) % 4) % 4)
    b = bytes(bin_chunk) + b"\0" * ((4 - len(bin_chunk) % 4) % 4)
    total = 12 + 8 + len(j) + (8 + len(b) if b else 0)
    out = struct.pack("<III", GLB_MAGIC, 2, total) + struct.pack("<II", len(j), CHUNK_JSON) + j
    if b:
        out += struct.pack("<II", len(b), CHUNK_BIN) + b
    return out
