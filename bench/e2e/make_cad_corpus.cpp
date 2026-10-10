// Builds the CAD part of the e2e corpus: one named, coloured assembly
// (bracket + peg + knob, one instance placed twice) written as STEP, IGES, GLB and OBJ.
//   g++ -std=c++17 -I/usr/include/opencascade bench/e2e/make_cad_corpus.cpp ... -o mk && ./mk OUTDIR

#include <BRepAlgoAPI_Cut.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <IGESCAFControl_Writer.hxx>
#include <Message_ProgressRange.hxx>
#include <Quantity_Color.hxx>
#include <RWGltf_CafWriter.hxx>
#include <RWMesh_CoordinateSystem.hxx>
#include <RWObj_CafWriter.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <TColStd_IndexedDataMapOfStringString.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <gp_Ax2.hxx>
#include <gp_Trsf.hxx>

#include <cstdio>
#include <string>

static TDF_Label add_part(const Handle(XCAFDoc_ShapeTool) &shapes, const Handle(XCAFDoc_ColorTool) &colours,
                          const TopoDS_Shape &s, const char *name, double r, double g, double b)
{
    TDF_Label l = shapes->AddShape(s, false);
    TDataStd_Name::Set(l, name);
    colours->SetColor(l, Quantity_Color(r, g, b, Quantity_TOC_sRGB), XCAFDoc_ColorSurf);
    return l;
}

static TopLoc_Location at(double x, double y, double z)
{
    gp_Trsf t;
    t.SetTranslation(gp_Vec(x, y, z));
    return TopLoc_Location(t);
}

int main(int argc, char **argv)
{
    std::string out = argc > 1 ? argv[1] : ".";
    Handle(TDocStd_Document) doc;
    XCAFApp_Application::GetApplication()->NewDocument("BinXCAF", doc);
    Handle(XCAFDoc_ShapeTool) shapes = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    Handle(XCAFDoc_ColorTool) colours = XCAFDoc_DocumentTool::ColorTool(doc->Main());

    // Bracket: plate with a slot cut out (curved + planar faces).
    TopoDS_Shape plate = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 60, 30, 6).Shape();
    TopoDS_Shape hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(15, 15, -1), gp::DZ()), 6, 8).Shape();
    TopoDS_Shape bracket = BRepAlgoAPI_Cut(plate, hole).Shape();
    TopoDS_Shape peg = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp::DZ()), 4, 20).Shape();
    TopoDS_Shape knob = BRepPrimAPI_MakeSphere(gp_Pnt(0, 0, 0), 7).Shape();

    TDF_Label bracket_l = add_part(shapes, colours, bracket, "Bracket", 0.20, 0.45, 0.85);
    TDF_Label peg_l = add_part(shapes, colours, peg, "Peg", 0.95, 0.60, 0.15);
    TDF_Label knob_l = add_part(shapes, colours, knob, "Knob", 0.30, 0.75, 0.35);

    TDF_Label asm_l = shapes->NewShape();
    TDataStd_Name::Set(asm_l, "Assembly");
    shapes->AddComponent(asm_l, bracket_l, at(0, 0, 0));
    shapes->AddComponent(asm_l, peg_l, at(45, 15, 6));
    shapes->AddComponent(asm_l, peg_l, at(52, 8, 6));      // same part placed twice
    shapes->AddComponent(asm_l, knob_l, at(45, 15, 33));
    shapes->UpdateAssemblies();

    bool ok = true;
    {
        STEPCAFControl_Writer w;
        w.SetColorMode(true);
        w.SetNameMode(true);
        ok &= w.Transfer(doc, STEPControl_AsIs) && w.Write((out + "/assembly.step").c_str()) == IFSelect_RetDone;
    }
    {
        IGESCAFControl_Writer w;
        w.SetColorMode(true);
        w.SetNameMode(true);
        ok &= w.Transfer(doc) && w.Write((out + "/assembly.iges").c_str());
    }
    // Mesh formats need triangulation.
    BRepMesh_IncrementalMesh(bracket, 0.1, false, 0.3, true);
    BRepMesh_IncrementalMesh(peg, 0.1, false, 0.3, true);
    BRepMesh_IncrementalMesh(knob, 0.1, false, 0.3, true);
    TColStd_IndexedDataMapOfStringString info;
    {
        RWGltf_CafWriter w((out + "/assembly.glb").c_str(), true);
        w.ChangeCoordinateSystemConverter().SetInputLengthUnit(0.001);
        w.ChangeCoordinateSystemConverter().SetInputCoordinateSystem(RWMesh_CoordinateSystem_Zup);
        ok &= w.Perform(doc, info, Message_ProgressRange());
    }
    {
        RWObj_CafWriter w((out + "/assembly.obj").c_str());
        w.ChangeCoordinateSystemConverter().SetInputLengthUnit(0.001);
        w.ChangeCoordinateSystemConverter().SetOutputLengthUnit(0.001);
        w.ChangeCoordinateSystemConverter().SetInputCoordinateSystem(RWMesh_CoordinateSystem_Zup);
        w.ChangeCoordinateSystemConverter().SetOutputCoordinateSystem(RWMesh_CoordinateSystem_glTF);
        ok &= w.Perform(doc, info, Message_ProgressRange());
    }
    printf(ok ? "wrote assembly.{step,iges,glb,obj} to %s\n" : "some writes failed (%s)\n", out.c_str());
    return ok ? 0 : 1;
}
