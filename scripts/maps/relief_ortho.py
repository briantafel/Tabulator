"""Blender (Cycles) top-down orthographic render of a heightmap as white plaster.

blender -b -P relief_ortho.py -- HEIGHT.npy META.json OUT_PREFIX
META: {"width_m", "height_m", "px": [w, h], "exag", "light": [[name, az, el, strength, angle], ...]}
Writes OUT_PREFIX-<name>.png per lighting setup, pixel-aligned with the map (north up).
The relief is static per resort, so this runs once and is cached; only the snow changes.
"""
import bpy, json, math, os, sys
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
H = np.load(argv[0]); meta = json.load(open(argv[1])); OUT = argv[2]
wpx, hpx = meta["px"]
SC = 1 / 1000.0
w, h = meta["width_m"] * SC, meta["height_m"] * SC
Z = (H - H.min()) * SC * meta.get("exag", 1.5)
nr, nc = H.shape

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"
sc.cycles.samples = int(os.environ.get("SAMPLES", "48")); sc.cycles.use_denoising = True
sc.view_settings.view_transform = "Standard"; sc.view_settings.look = "Medium High Contrast"
sc.view_settings.exposure = meta.get("exposure", 0.0)
sc.render.resolution_x, sc.render.resolution_y = wpx, hpx

xs = np.linspace(-w / 2, w / 2, nc); ys = np.linspace(h / 2, -h / 2, nr)
verts = [(xs[c], ys[r], float(Z[r, c])) for r in range(nr) for c in range(nc)]
faces = [(r * nc + c, r * nc + c + 1, (r + 1) * nc + c + 1, (r + 1) * nc + c) for r in range(nr - 1) for c in range(nc - 1)]
me = bpy.data.meshes.new("t"); me.from_pydata(verts, [], faces); me.update()
for p in me.polygons: p.use_smooth = True
ob = bpy.data.objects.new("t", me); sc.collection.objects.link(ob)

m = bpy.data.materials.new("plaster"); m.use_nodes = True
nt = m.node_tree; b = nt.nodes["Principled BSDF"]
b.inputs["Base Color"].default_value = (0.93, 0.93, 0.935, 1)
b.inputs["Roughness"].default_value = 0.95
if "Specular IOR Level" in b.inputs: b.inputs["Specular IOR Level"].default_value = 0.1
noise = nt.nodes.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 2500.0; noise.inputs["Detail"].default_value = 4.0
bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.025; bump.inputs["Distance"].default_value = 0.0005
nt.links.new(noise.outputs["Fac"], bump.inputs["Height"]); nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
ob.data.materials.append(m)

world = bpy.data.worlds.new("w"); sc.world = world; world.use_nodes = True
bg = world.node_tree.nodes["Background"]

cam_d = bpy.data.cameras.new("c"); cam_d.type = "ORTHO"; cam_d.ortho_scale = max(w, h)
cam = bpy.data.objects.new("c", cam_d); sc.collection.objects.link(cam); sc.camera = cam
cam.location = (0, 0, float(Z.max()) + 5.0); cam.rotation_euler = (0, 0, 0)
cam_d.clip_end = 50

sun_d = bpy.data.lights.new("sun", "SUN"); sun = bpy.data.objects.new("sun", sun_d); sc.collection.objects.link(sun)
for name, az, el, strength, angle, sky in meta["light"]:
    a, e = math.radians(az), math.radians(el)
    src = Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)))
    sun.rotation_euler = (-src).to_track_quat("-Z", "Y").to_euler()
    sun_d.energy = strength; sun_d.angle = math.radians(angle)
    bg.inputs["Color"].default_value = (1, 1, 1, 1); bg.inputs["Strength"].default_value = sky
    sc.render.filepath = f"{OUT}-{name}.png"
    bpy.ops.render.render(write_still=True)
    print("rendered", name, flush=True)
