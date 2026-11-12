"""Original, more natural octopus studies. Blender 5.2 --background --python this-file.

Renders on a sandy floor rather than floating. Inspired by marine anatomy, not
copied stock geometry. The website's product mark is deliberately unchanged.
"""
import bpy, math, random, os
from pathlib import Path
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'public/design/natural'
OUT.mkdir(parents=True,exist_ok=True)
SOURCE=Path(__file__).resolve().parent

def skin(name,color):
    m=bpy.data.materials.new(name);m.use_nodes=True
    n=m.node_tree.nodes;l=m.node_tree.links;b=n.get('Principled BSDF')
    b.inputs['Base Color'].default_value=(*color,1)
    b.inputs['Roughness'].default_value=.35
    b.inputs['Subsurface Weight'].default_value=.16
    b.inputs['Subsurface Radius'].default_value=(1,.48,.28)
    b.inputs['Coat Weight'].default_value=.1
    noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=95;noise.inputs['Detail'].default_value=3
    bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.075;bump.inputs['Distance'].default_value=.006
    l.new(noise.outputs['Fac'],bump.inputs['Height']);l.new(bump.outputs['Normal'],b.inputs['Normal'])
    ramp=n.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].position=.24;ramp.color_ramp.elements[0].color=(*(c*.8 for c in color),1)
    ramp.color_ramp.elements[1].position=.75;ramp.color_ramp.elements[1].color=(*(min(1,c*1.07+.02) for c in color),1)
    l.new(noise.outputs['Fac'],ramp.inputs[0]);l.new(ramp.outputs[0],b.inputs['Base Color'])
    return m

def solid(name,color,rough=.35):
    m=bpy.data.materials.new(name);m.use_nodes=True;b=m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value=(*color,1);b.inputs['Roughness'].default_value=rough
    return m

def sphere(name,pos,scale,mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64,ring_count=40,location=pos)
    o=bpy.context.object;o.name=name;o.scale=scale;o.data.materials.append(mat)
    for p in o.data.polygons:p.use_smooth=True
    return o

def mesh(name,vertices,faces,mat):
    data=bpy.data.meshes.new(name);data.from_pydata(vertices,[],faces);data.update()
    o=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(o);data.materials.append(mat)
    for p in data.polygons:p.use_smooth=True
    return o

def curve(points,t):
    k=min(int(t*(len(points)-1)),len(points)-2);u=t*(len(points)-1)-k
    p0=Vector(points[max(0,k-1)]);p1=Vector(points[k]);p2=Vector(points[k+1]);p3=Vector(points[min(len(points)-1,k+2)])
    return .5*((2*p1)+(-p0+p2)*u+(2*p0-5*p1+4*p2-p3)*u*u+(-p0+3*p1-3*p2+p3)*u*u*u)

def tube(name,points,radii,mat):
    verts=[];faces=[];normal=None;sides=20
    for i,p in enumerate(points):
        tangent=(Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])).normalized()
        normal=(normal-tangent*normal.dot(tangent)).normalized() if normal else tangent.cross(Vector((0,0,1))).normalized()
        bitangent=tangent.cross(normal).normalized()
        for j in range(sides):
            a=j/sides*math.tau;verts.append(Vector(p)+radii[i]*(normal*math.cos(a)+bitangent*math.sin(a)))
            if i:faces.append(((i-1)*sides+j,(i-1)*sides+(j+1)%sides,i*sides+(j+1)%sides,i*sides+j))
    faces.extend([tuple(reversed(range(sides))),tuple((len(points)-1)*sides+j for j in range(sides))])
    o=mesh(name,verts,faces,mat);sub=o.modifiers.new('Smooth arm','SUBSURF');sub.levels=1
    return o

def area(name,pos,power,color,size):
    bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.name=name;o.data.energy=power;o.data.color=color;o.data.shape='DISK';o.data.size=size
    o.rotation_euler=(Vector((0,0,.8))-o.location).to_track_quat('-Z','Y').to_euler()

for kind,color in [('dumbo',(.78,.39,.28)),('reef',(.13,.29,.40)),('inky',(.40,.28,.56))]:
    if os.environ.get('OCTIPUS_ONLY_KIND') and os.environ['OCTIPUS_ONLY_KIND'] != kind: continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    random.seed(8)
    body=skin('Fine mottled skin',color)
    underside=skin('Pale underside',tuple(c*.65+.22 for c in color))
    eye=solid('Deep black eyes',(.003,.009,.015),.09)
    bpy.context.scene.world=bpy.data.worlds.new('Deep water studio');bpy.context.scene.world.use_nodes=True
    bpy.context.scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.045,.09,.12,1)
    bpy.context.scene.world.node_tree.nodes['Background'].inputs[1].default_value=.32
    mantle=sphere('Mantle',(0,.13,.99),(.76,.68,.79 if kind=='dumbo' else .86 if kind=='inky' else .68),body)
    sphere('Soft arm crown',(0,0,.45),(.62,.58,.32),body)
    for arm in range(8):
        angle=arm*math.tau/8+.15
        height=.28+.10*math.sin(arm*1.4)
        control=[(.32,0,.46),(.67,0,.20),(1.13,.02,.14),(1.43,.07,height),(1.48,.10,height+.22),(1.33,.14,height+.29),(1.24,.16,height+.15)]
        if arm in [1,4,6]:control=[(r*.9,y,z+.09*(i/6)) for i,(r,y,z) in enumerate(control)]
        pts=[];radii=[]
        for j in range(101):
            t=j/100;p=curve(control,t)
            pts.append((p.x*math.cos(angle)-p.y*math.sin(angle),p.x*math.sin(angle)+p.y*math.cos(angle),p.z))
            radii.append(.19*(1-t)**.9+.028)
        tube('Arm %d'%arm,pts,radii,body)
        # Two rows of real recessed sucker rings, following the exposed underside.
        for j in range(19,92,8):
            t=j/100;p=Vector(pts[j]);tangent=(Vector(pts[j+1])-Vector(pts[j-1])).normalized()
            down=Vector((0,0,-1));normal=(down-tangent*down.dot(tangent)).normalized()
            side=tangent.cross(normal).normalized()
            for sign in [-1,1]:
                center=p+normal*radii[j]*.83+side*radii[j]*.40*sign
                bpy.ops.mesh.primitive_torus_add(major_segments=20,minor_segments=8,location=center,major_radius=radii[j]*.27,minor_radius=radii[j]*.075)
                o=bpy.context.object;o.name='Sucker ring';o.rotation_euler=normal.to_track_quat('Z','Y').to_euler();o.data.materials.append(underside)
                for face in o.data.polygons:face.use_smooth=True
    # Scalloped membrane between arms, thin and gently sloping toward the floor.
    vertices=[];faces=[];segments=160;rings=12
    for ring in range(rings):
        t=ring/(rings-1)
        for j in range(segments):
            a=j/segments*math.tau+.15
            edge=.79+.32*((1+math.cos(a*8-1.2))/2)**2
            r=.30+(edge-.30)*t
            vertices.append((r*math.cos(a),r*math.sin(a),.44-.23*t-.025*math.sin(t*math.pi)))
            if ring:faces.append(((ring-1)*segments+j,(ring-1)*segments+(j+1)%segments,ring*segments+(j+1)%segments,ring*segments+j))
    web=mesh('Inter-arm web',vertices,faces,body);thick=web.modifiers.new('Soft membrane','SOLIDIFY');thick.thickness=.055
    # Fuse the mantle, crown, arms and membrane without collars or detachable toy limbs.
    bpy.ops.object.select_all(action='DESELECT')
    for o in list(bpy.context.scene.objects):
        if o.name.startswith(('Mantle','Soft arm','Arm ','Inter-arm')):
            o.select_set(True);bpy.context.view_layer.objects.active=o
            for modifier in list(o.modifiers):bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.ops.object.join();o=bpy.context.object;o.name='Continuous octopus skin'
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    remesh=o.modifiers.new('Organic union','REMESH');remesh.mode='VOXEL';remesh.voxel_size=.018
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    smooth=o.modifiers.new('Gentle surface','SMOOTH');smooth.factor=.7;smooth.iterations=5
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    for p in o.data.polygons:p.use_smooth=True
    # Lateral dark eyes: no white cartoon eyeballs or painted human smile.
    for sign in [-1,1]:
        rim=sphere('Soft eye surround',(sign*.49,-.45,1.0),(.24,.17,.27),body)
        eyeball=sphere('Glossy eye',(sign*.51,-.566,1.01),(.18,.105,.215),eye)
        eyeball.rotation_euler.z=sign*.23
    if kind=='dumbo':
        for sign in [-1,1]:
            fin=sphere('Dumbo fin',(sign*.69,.10,1.57),(.32,.075,.25),underside)
            fin.rotation_euler.y=sign*-.32;fin.rotation_euler.z=sign*.2
    # Save model-only GLB; the contact-ground and light rig are render staging.
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=str(OUT/(kind+'.glb')),use_selection=True,export_format='GLB')
    sand=skin('Fine sea floor',(.19,.25,.24))
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.06));floor=bpy.context.object;floor.name='Sea floor';floor.data.materials.append(sand)
    # Pebbles are intentionally subtle: contact and scale, not a decorative pedestal.
    pebblemat=solid('Small sand stones',(.22,.28,.26),.85)
    for i in range(110):
        x=random.uniform(-4,4);y=random.uniform(-3,4)
        if abs(x)<1.6 and abs(y)<1.5:continue
        size=random.uniform(.008,.035)
        sphere('Seafloor grain',(x,y,-.05),(size,size*.8,size*.6),pebblemat)
    area('Filtered daylight',(-3,-4,5),520,(.72,.88,1),4)
    area('Warm scattered light',(3,-1,3),220,(1,.75,.59),3)
    area('Underwater edge',(0,3,4),650,(.40,.83,.86),3)
    bpy.ops.object.camera_add(location=(2.65,-5.6,2.75));cam=bpy.context.object
    cam.rotation_euler=(Vector((0,0,.78))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=3.85
    scene=bpy.context.scene;scene.camera=cam;scene.render.engine='CYCLES';scene.cycles.samples=96;scene.cycles.use_denoising=True
    scene.render.resolution_x=1200;scene.render.resolution_y=1200;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG';scene.render.filepath=str(OUT/(kind+'.png'))
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/(kind+'.blend')))
    bpy.ops.render.render(write_still=True)
    print('NATURAL_RENDER_COMPLETE',kind,flush=True)
