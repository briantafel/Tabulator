"""Blender (Cycles) top-down orthographic plaster relief from a packed 16-bit heightmap, at 4K.

Terrain pilot (claude/state-2026-11-19-terrain-pilot.md). Same look as relief_ortho.py ("even" lights,
plaster material, orthographic top-down camera); the terrain is a coarse grid that Blender subdivides
and displaces from the heightmap at render time, so the DEM (not the mesh) limits detail and the
.blend stays small.

  blender -b -P relief_heightmap.py -- HEIGHTMAP16.png META.json OUT_PREFIX      (or: python relief_heightmap.py ...)

META (json):
  id, region_m (side of the heightmap square), frame_m (side seen by the camera), px (render size),
  z_min, z_max (metres, what 0 and 65535 mean), exag, light, exposure, samples,
  noise_scale, bump_distance (BU = km), mesh_base, render_levels, viewport_levels, levels (for the notes)
Writes OUT_PREFIX.blend (images packed) and the render, before the levels step, as OUT_PREFIX-raw-<i>-<j>.png
(tiles x tiles crops, listed in OUT_PREFIX-tiles.json; tiles=1 is one frame),
and prints "rendered <seconds>" and "blend_mb <size>".
Fails loudly if the displaced mesh does not follow the heightmap (e.g. a 16-bit PNG read as 8-bit).
"""
import json, math, os, sys, time

import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
HM, META, OUT = argv[0], json.load(open(argv[1])), argv[2]
SC = 1 / 1000.0                       # 1 Blender unit = 1 km
region = META["region_m"] * SC
frame = META["frame_m"] * SC
px = int(META["px"])
zmin, zmax = float(META["z_min"]), float(META["z_max"])
strength = (zmax - zmin) * SC * META.get("exag", 2.0)
n0, lv_r, lv_v = META.get("mesh_base", 160), META.get("render_levels", 3), META.get("viewport_levels", 1)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.samples = int(os.environ.get("SAMPLES", META.get("samples", 48)))
sc.cycles.use_denoising = True
sc.view_settings.view_transform = "Standard"
sc.view_settings.look = "None"
sc.view_settings.exposure = META.get("exposure", -0.9)
sc.render.resolution_x = sc.render.resolution_y = px
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGB"
sc.render.image_settings.color_depth = "8"
sc.render.filepath = f"//{META['id']}-render.png"

# --- heightmap: 16-bit PNG, non-colour, packed into the file
img = bpy.data.images.load(os.path.abspath(HM))
img.colorspace_settings.name = "Non-Color"
img.name = f"{META['id']}-heightmap16"
print(f"heightmap {img.size[0]}x{img.size[1]}, float buffer: {img.is_float}, depth {img.depth}", flush=True)

# --- terrain: an n0 x n0 grid with UVs, Subdivision (simple) then Displace from the heightmap
xs = np.linspace(-region / 2, region / 2, n0 + 1)
verts = [(float(x), float(y), 0.0) for y in xs for x in xs]
faces = [(r * (n0 + 1) + c, r * (n0 + 1) + c + 1, (r + 1) * (n0 + 1) + c + 1, (r + 1) * (n0 + 1) + c)
         for r in range(n0) for c in range(n0)]
me = bpy.data.meshes.new("terrain")
me.from_pydata(verts, [], faces)
me.update()
uv = me.uv_layers.new(name="UVMap")
uvd = np.empty((len(me.loops), 2), dtype=np.float32)
co = np.array([v.co[:2] for v in me.vertices], dtype=np.float32)
lv = np.array([l.vertex_index for l in me.loops])
uvd[:] = co[lv] / region + 0.5                   # u east, v north: image row 0 is the north edge
uv.data.foreach_set("uv", uvd.ravel())
for p in me.polygons:
    p.use_smooth = True
ob = bpy.data.objects.new("terrain", me)
sc.collection.objects.link(ob)

sub = ob.modifiers.new("subdivide", "SUBSURF")
sub.subdivision_type = "SIMPLE"
sub.levels, sub.render_levels = lv_v, lv_r
tex = bpy.data.textures.new("heightmap", "IMAGE")
tex.image = img
tex.extension = "EXTEND"
tex.use_interpolation = True
disp = ob.modifiers.new("displace", "DISPLACE")
disp.texture = tex
disp.texture_coords = "UV"
disp.uv_layer = "UVMap"
disp.direction = "Z"
disp.mid_level = 0.0
disp.strength = strength

# --- check the displaced mesh against the heightmap (loud if the 16-bit data is not used)
dg = bpy.context.evaluated_depsgraph_get()
ev = ob.evaluated_get(dg)
m2 = ev.to_mesh()
P = np.empty(len(m2.vertices) * 3, dtype=np.float64)
m2.vertices.foreach_get("co", P)
P = P.reshape(-1, 3)
inner = np.where((abs(P[:, 0] / region) < 0.48) & (abs(P[:, 1] / region) < 0.48))[0]   # the outer ring is never in frame
sel = np.random.default_rng(1).choice(inner, min(20000, len(inner)), replace=False)
raw = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
img.pixels.foreach_get(raw)
hm = raw.reshape(img.size[1], img.size[0], 4)[::-1, :, 0]     # Blender stores bottom row first -> row 0 = north


def bilinear(a, rr, cc):          # (Blender's bundled Python has numpy but not scipy)
    rr = np.clip(rr, 0, a.shape[0] - 1)
    cc = np.clip(cc, 0, a.shape[1] - 1)
    r0, c0 = np.floor(rr).astype(int), np.floor(cc).astype(int)
    r1, c1 = np.minimum(r0 + 1, a.shape[0] - 1), np.minimum(c0 + 1, a.shape[1] - 1)
    fr, fc = rr - r0, cc - c0
    return (a[r0, c0] * (1 - fr) * (1 - fc) + a[r0, c1] * (1 - fr) * fc + a[r1, c0] * fr * (1 - fc) + a[r1, c1] * fr * fc)


u = P[sel, 0] / region + 0.5
v = P[sel, 1] / region + 0.5
want = bilinear(hm, (1 - v) * hm.shape[0] - 0.5, u * hm.shape[1] - 0.5) * strength
err = np.abs(P[sel, 2] - want).max() / strength
steps = len(np.unique(np.round(hm[::7, ::7] * 65535)))
print(f"displacement check: max error {err:.2e} of the height range, {steps} distinct 16-bit levels sampled", flush=True)
if err > 3e-4 or steps < 400:
    sys.exit(f"heightmap displacement does not follow the 16-bit data (error {err:.2e}, {steps} levels): "
             f"Blender read it at low precision. Refusing to render a terraced relief.")
ev.to_mesh_clear()

# --- plaster material (as relief_ortho.py; grain and bump scaled so they sit at the same size per pixel)
m = bpy.data.materials.new("plaster")
m.use_nodes = True
nt = m.node_tree
b = nt.nodes["Principled BSDF"]
b.inputs["Base Color"].default_value = (0.93, 0.93, 0.935, 1)
b.inputs["Roughness"].default_value = 0.95
if "Specular IOR Level" in b.inputs:
    b.inputs["Specular IOR Level"].default_value = 0.1
noise = nt.nodes.new("ShaderNodeTexNoise")
noise.inputs["Scale"].default_value = META["noise_scale"]
noise.inputs["Detail"].default_value = 4.0
bump = nt.nodes.new("ShaderNodeBump")
bump.inputs["Strength"].default_value = 0.025
bump.inputs["Distance"].default_value = META["bump_distance"]
nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
ob.data.materials.append(m)

world = bpy.data.worlds.new("w")
sc.world = world
try:
    world.use_nodes = True
except Exception:
    pass
bg = world.node_tree.nodes["Background"]

# --- camera: orthographic, straight down, framed to the square frame (centre of the heightmap)
cam_d = bpy.data.cameras.new("c")
cam_d.type = "ORTHO"
cam_d.ortho_scale = frame
cam_d.clip_end = 50
cam = bpy.data.objects.new("camera", cam_d)
sc.collection.objects.link(cam)
sc.camera = cam
cam.location = (0, 0, strength + 5.0)
cam.rotation_euler = (0, 0, 0)


def aim(obj, az, el):
    a, e = math.radians(az), math.radians(el)
    src = Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)))
    obj.rotation_euler = (-src).to_track_quat("-Z", "Y").to_euler()


# --- the "even" lights: broad key sun + shadowless fill + sky (settled 2026-11-19)
sun_d = bpy.data.lights.new("key sun", "SUN")
sun = bpy.data.objects.new("key sun", sun_d)
sc.collection.objects.link(sun)
fill_d = bpy.data.lights.new("fill sun (no shadow)", "SUN")
fill = bpy.data.objects.new("fill sun (no shadow)", fill_d)
sc.collection.objects.link(fill)
if hasattr(fill_d, "use_shadow"):
    fill_d.use_shadow = False
try:
    fill_d.cycles.cast_shadow = False
except Exception:
    pass
name, az, el, key, soft, sky, *fl = META["light"][0]
aim(sun, az, el)
sun_d.energy, sun_d.angle = key, math.radians(soft)
f_az, f_el, f_str = fl[0]
aim(fill, f_az, f_el)
fill_d.energy, fill_d.angle = f_str, math.radians(30)
bg.inputs["Color"].default_value = (1, 1, 1, 1)
bg.inputs["Strength"].default_value = sky

# --- notes for whoever opens the file
sc["tabulator_id"] = META["id"]
sc["tabulator_heightmap_z_range_m"] = [zmin, zmax]
sc["tabulator_exaggeration"] = META.get("exag", 2.0)
sc["tabulator_frame_m"] = META["frame_m"]
sc["tabulator_levels_after_render"] = json.dumps(META.get("levels", {}))
sc["tabulator_note"] = ("Render is the raw plaster relief. The published map applies a levels step afterwards "
                        "(percentiles of this render -> 0.52..0.975, gamma 0.85); numbers in tabulator_levels_after_render.")

bpy.ops.file.pack_all()
blend = f"{OUT}.blend"
bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(blend), compress=True)
print(f"blend_mb {os.path.getsize(blend) / 1e6:.1f}", flush=True)

# --- render. Denoising a whole 4096 px frame needs ~5 GB; so render tiles x tiles crops with an overlap and
# let the caller stitch the kept centres (Cycles seeds per pixel, so the noise is the same as one big render).
tiles = int(META.get("tiles", 1))
ov = 64
T = px // tiles
sc.render.use_persistent_data = True
t0 = time.time()
index = []
for ti in range(tiles):
    for tj in range(tiles):
        kx0, kx1, ky0, ky1 = tj * T, (tj + 1) * T if tj < tiles - 1 else px, ti * T, (ti + 1) * T if ti < tiles - 1 else px
        fn = os.path.abspath(f"{OUT}-raw-{ti}-{tj}.png")
        if tiles == 1:
            x0, x1, y0, y1 = 0, px, 0, px
            sc.render.use_border = False
        else:
            x0, x1, y0, y1 = max(0, kx0 - ov), min(px, kx1 + ov), max(0, ky0 - ov), min(px, ky1 + ov)
            sc.render.use_border = True
            sc.render.use_crop_to_border = True
            sc.render.border_min_x, sc.render.border_max_x = x0 / px, x1 / px
            sc.render.border_min_y, sc.render.border_max_y = 1 - y1 / px, 1 - y0 / px     # Blender's y runs up
        sc.render.filepath = fn
        bpy.ops.render.render(write_still=True)
        index.append({"file": fn, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "kx0": kx0, "kx1": kx1, "ky0": ky0, "ky1": ky1})
        print(f"tile {ti},{tj} done {time.time() - t0:.0f}s", flush=True)
json.dump(index, open(f"{OUT}-tiles.json", "w"))
print(f"rendered {time.time() - t0:.0f}", flush=True)
