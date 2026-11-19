"""Blender (Cycles) render of a heightmap as a white plaster relief model.

blender -b -P render.py -- HEIGHT.npy META.json OUTDIR
Frames (each a PNG): see SHOTS. Plaster = white diffuse, matte, with a fine noise bump;
the model is a slab with cut sides standing on a seamless backdrop, lit by a low key
light plus a large soft fill, like a product shot of a physical model.
"""
import bpy, bmesh, json, math, os, sys
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
H = np.load(argv[0]); meta = json.load(open(argv[1])); OUT = argv[2]
os.makedirs(OUT, exist_ok=True)

EXAG = 1.25            # a touch of heroism
SCALE = 1 / 1000.0     # metres -> scene units (km)
BASE_DEPTH = 0.35      # slab thickness below the lowest point, km
SAMPLES = int(os.environ.get("SAMPLES", "96"))

# ---------------------------------------------------------------- scene reset
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = True
sc.render.film_transparent = False
sc.view_settings.view_transform = "AgX"
sc.view_settings.look = "AgX - Punchy"

# ---------------------------------------------------------------- terrain slab
n_r, n_c = H.shape
cell = meta["cell_m"] * SCALE
zmin = float(H.min())
Z = (H - zmin) * SCALE * EXAG
w, h = (n_c - 1) * cell, (n_r - 1) * cell
xs = np.linspace(-w / 2, w / 2, n_c)
ys = np.linspace(h / 2, -h / 2, n_r)          # row 0 = north
verts = [(xs[c], ys[r], float(Z[r, c])) for r in range(n_r) for c in range(n_c)]
faces = [(r * n_c + c, r * n_c + c + 1, (r + 1) * n_c + c + 1, (r + 1) * n_c + c)
         for r in range(n_r - 1) for c in range(n_c - 1)]
me = bpy.data.meshes.new("terrain"); me.from_pydata(verts, [], faces); me.update()
ob = bpy.data.objects.new("terrain", me); sc.collection.objects.link(ob)
bm = bmesh.new(); bm.from_mesh(me)
edges = [e for e in bm.edges if e.is_boundary]
ret = bmesh.ops.extrude_edge_only(bm, edges=edges)
newv = [v for v in ret["geom"] if isinstance(v, bmesh.types.BMVert)]
for v in newv:
    v.co.z = -BASE_DEPTH
bottom = bmesh.ops.contextual_create(bm, geom=[e for e in ret["geom"] if isinstance(e, bmesh.types.BMEdge)])
bm.normal_update(); bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bm.to_mesh(me); bm.free()
for p in me.polygons:
    p.use_smooth = True
try:
    me.set_sharp_from_angle(angle=math.radians(50))   # crisp cut edges, smooth terrain (Blender 4.1+)
except Exception:
    pass

def plaster(name, color=(0.88, 0.885, 0.89, 1), grain=0.035):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color
    b.inputs["Roughness"].default_value = 0.92
    if "Specular IOR Level" in b.inputs: b.inputs["Specular IOR Level"].default_value = 0.15
    if "Subsurface Weight" in b.inputs:
        b.inputs["Subsurface Weight"].default_value = 0.04
    noise = nt.nodes.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 900.0
    noise.inputs["Detail"].default_value = 6.0
    bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = grain
    bump.inputs["Distance"].default_value = 0.002
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"]); nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    return m
ob.data.materials.append(plaster("plaster"))

# ---------------------------------------------------------------- backdrop
bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, -BASE_DEPTH))
floor = bpy.context.active_object
floor_mat = plaster("floor", grain=0.0)
floor.data.materials.append(floor_mat)

world = bpy.data.worlds.new("world"); sc.world = world; world.use_nodes = True
bg = world.node_tree.nodes["Background"]

# ---------------------------------------------------------------- lights
def sun(az_deg, el_deg, strength, angle_deg):
    d = bpy.data.lights.new("sun", "SUN"); d.energy = strength; d.angle = math.radians(angle_deg)
    o = bpy.data.objects.new("sun", d); sc.collection.objects.link(o)
    az, el = math.radians(az_deg), math.radians(el_deg)
    # direction the light travels: from (az, el) toward the origin
    src = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
    o.rotation_euler = (-src).to_track_quat("-Z", "Y").to_euler()
    return o
key = sun(165, 17, 5.5, 1.5)      # low raking key from the SSE: side light for a camera in the east
fill = sun(300, 55, 0.22, 30)     # faint fill so shadow faces stay deep

# ---------------------------------------------------------------- camera
cam_d = bpy.data.cameras.new("cam"); cam = bpy.data.objects.new("cam", cam_d); sc.collection.objects.link(cam)
sc.camera = cam
peak_r, peak_c = np.unravel_index(np.argmax(H), H.shape)
peak = Vector((xs[peak_c], ys[peak_r], float(Z[peak_r, peak_c])))

def look(az_deg, el_deg, dist, lens, target_drop=0.42):
    az, el = math.radians(az_deg), math.radians(el_deg)
    tgt = peak - Vector((0, 0, peak.z * target_drop))
    cam.location = tgt + dist * Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
    cam.rotation_euler = (tgt - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_d.lens = lens

SHOTS = [
    # name, cam azimuth (from N, deg), elevation, distance km, lens mm, background, res, floor seen
    ("01-hero-light", 95, 5, 11.0, 105, "light", (1600, 2000), False),
    ("02-hero-dark", 95, 5, 11.0, 105, "dark", (1600, 2000), False),
    ("03-slab-light", 140, 28, 19.0, 55, "light", (2000, 1600), True),
]
for name, az, el, dist, lens, bgk, (rx, ry), floor_seen in SHOTS:
    floor.visible_camera = floor_seen
    if bgk == "light":
        bg.inputs["Color"].default_value = (0.80, 0.81, 0.83, 1); bg.inputs["Strength"].default_value = 0.45
        floor_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.78, 0.79, 0.81, 1)
    else:
        bg.inputs["Color"].default_value = (0.035, 0.045, 0.055, 1); bg.inputs["Strength"].default_value = 0.35
        floor_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.03, 0.035, 0.04, 1)
    look(az, el, dist, lens)
    sc.render.resolution_x, sc.render.resolution_y = rx, ry
    sc.render.filepath = os.path.join(OUT, name + ".png")
    bpy.ops.render.render(write_still=True)
    print("rendered", name, flush=True)
