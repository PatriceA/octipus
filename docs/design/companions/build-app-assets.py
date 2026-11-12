"""Render the existing account form/color combinations for web and Flutter."""
import bpy
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'public/design/natural/app'
OUT.mkdir(parents=True,exist_ok=True)
COLORS={'sea-glass':'92c9c5','coral':'efa99b','lavender':'b7a6e8','sunshine':'e9c776','blue':'82b5df'}
def linear(c):
    return c/12.92 if c <= .04045 else ((c+.055)/1.055)**2.4
for form,model in [('pebble','dumbo'),('ribbon','reef'),('ink','inky')]:
    bpy.ops.wm.open_mainfile(filepath=str(Path(__file__).parent/(model+'.blend')))
    scene=bpy.context.scene
    scene.render.resolution_x=512;scene.render.resolution_y=512
    scene.cycles.samples=32
    for color,value in COLORS.items():
        rgb=tuple(linear(int(value[i:i+2],16)/255) for i in (0,2,4))
        for name,base in [('Fine mottled skin',rgb),('Pale underside',tuple(c*.65+.18 for c in rgb))]:
            material=bpy.data.materials[name]
            shader=material.node_tree.nodes.get('Principled BSDF')
            shader.inputs['Base Color'].default_value=(*base,1)
            ramp=next(node for node in material.node_tree.nodes if node.type=='VALTORGB')
            ramp.color_ramp.elements[0].color=(*(c*.8 for c in base),1)
            ramp.color_ramp.elements[1].color=(*(min(1,c*1.07+.02) for c in base),1)
        scene.render.filepath=str(OUT/(form+'-'+color+'.png'))
        bpy.ops.render.render(write_still=True)
        print('APP_RENDER_COMPLETE',form,color,flush=True)
