// oma-peek CAD formats via OpenCASCADE: STEP, IGES (B-rep, meshed here) and
// glTF/GLB, OBJ (meshes). Everything is read into an XCAF document so part
// names, placements and colours come through the same way for every format.
//
// Built two ways from this one file:
//   libmeshcad.so   C API below, embedded in the thumbnailer payload and loaded
//                   only for these formats (OCCT costs ~30 ms to load).
//   oma-peek-cad    (-DOMA_PEEK_CAD_MAIN) converter for the Sushi viewer:
//                   oma-peek-cad IN OUT.mpk  -> the viewer's "mpk" format.
//
// Coordinates are returned Z-up in millimetres, like STL/3MF.

#include <BRepBndLib.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <Bnd_Box.hxx>
#include <IGESCAFControl_Reader.hxx>
#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_ProgressRange.hxx>
#include <Poly_Triangle.hxx>
#include <Quantity_ColorRGBA.hxx>
#include <RWGltf_CafReader.hxx>
#include <RWMesh_CoordinateSystem.hxx>
#include <RWMesh_FaceIterator.hxx>
#include <RWObj_CafReader.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <TDataStd_Name.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDocStd_Document.hxx>
#include <TopoDS_Compound.hxx>
#include <BRep_Builder.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFPrs_DocumentExplorer.hxx>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <tuple>
#include <vector>

namespace {

enum Format { FMT_STEP = 1, FMT_IGES = 2, FMT_GLTF = 3, FMT_OBJ = 4 };

struct Part {
    std::string name;
    uint8_t rgb[3] = {0, 0, 0};
    int has_colour = 0;
    std::vector<float> tris;    // 9 floats per triangle
};

std::string label_name(const TDF_Label &label)
{
    Handle(TDataStd_Name) name;
    if (label.IsNull() || !label.FindAttribute(TDataStd_Name::GetID(), name))
        return {};
    TCollection_AsciiString s(name->Get(), '?');
    return s.ToCString();
}

bool read_document(const char *path, int format, Handle(TDocStd_Document) &doc)
{
    Handle(XCAFApp_Application) app = XCAFApp_Application::GetApplication();
    app->NewDocument("BinXCAF", doc);
    switch (format) {
    case FMT_STEP: {
        STEPCAFControl_Reader r;
        r.SetColorMode(true);
        r.SetNameMode(true);
        r.SetLayerMode(false);
        r.SetPropsMode(false);
        if (r.ReadFile(path) != IFSelect_RetDone)
            return false;
        return r.Transfer(doc);
    }
    case FMT_IGES: {
        IGESCAFControl_Reader r;
        r.SetColorMode(true);
        r.SetNameMode(true);
        r.SetLayerMode(false);
        if (r.ReadFile(path) != IFSelect_RetDone)
            return false;
        return r.Transfer(doc);
    }
    case FMT_GLTF:
    case FMT_OBJ: {
        // glTF is Y-up in metres; OBJ is conventionally Y-up too (as the old
        // Python OBJ loader assumed). Convert both to Z-up millimetres.
        Handle(RWMesh_CafReader) r;
        if (format == FMT_GLTF) {
            Handle(RWGltf_CafReader) g = new RWGltf_CafReader();
            g->SetParallel(true);
            r = g;
            r->SetFileLengthUnit(1.0);
        } else {
            r = new RWObj_CafReader();
            r->SetFileLengthUnit(0.001);
        }
        r->SetSystemLengthUnit(0.001);
        r->SetFileCoordinateSystem(RWMesh_CoordinateSystem_glTF);
        r->SetSystemCoordinateSystem(RWMesh_CoordinateSystem_Zup);
        r->SetDocument(doc);
        return r->Perform(TCollection_AsciiString(path), Message_ProgressRange());
    }
    }
    return false;
}

// STEP/IGES carry exact geometry: mesh it with a tolerance relative to the model
// size, so huge and tiny parts get similar triangle budgets.
void mesh_document(const Handle(TDocStd_Document) &doc, bool fine)
{
    Handle(XCAFDoc_ShapeTool) tool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    TDF_LabelSequence roots;
    tool->GetFreeShapes(roots);
    TopoDS_Compound all;
    BRep_Builder b;
    b.MakeCompound(all);
    for (const TDF_Label &l : roots)
        b.Add(all, XCAFDoc_ShapeTool::GetShape(l));
    Bnd_Box box;
    BRepBndLib::Add(all, box);
    if (box.IsVoid())
        return;
    double diag = std::sqrt(box.SquareExtent());
    // Thumbnails are 256 px: coarse is plenty. The interactive viewer zooms in, so mesh finer.
    if (fine)
        BRepMesh_IncrementalMesh(all, diag * 0.0004, false, 0.12, true);
    else
        BRepMesh_IncrementalMesh(all, diag * 0.002, false, 0.35, true);
}

std::vector<Part> collect(const Handle(TDocStd_Document) &doc)
{
    std::vector<Part> parts;
    std::map<std::tuple<int, int, int, int, int>, size_t> index;   // (node, has, r, g, b) -> part
    int node_no = 0;
    for (XCAFPrs_DocumentExplorer exp(doc, XCAFPrs_DocumentExplorerFlags_OnlyLeafNodes); exp.More();
         exp.Next(), node_no++) {
        const XCAFPrs_DocumentNode &node = exp.Current();
        // Instance names are often auto-generated ("=>[0:1:1:2]"); prefer the part's own name then.
        std::string name = label_name(node.Label);
        if (name.empty() || name.rfind("=>", 0) == 0) {
            std::string ref = label_name(node.RefLabel);
            if (!ref.empty())
                name = ref;
        }
        for (RWMesh_FaceIterator f(node.RefLabel, node.Location, true, node.Style); f.More(); f.Next()) {
            if (f.IsEmptyMesh())
                continue;
            int has = f.HasFaceColor() ? 1 : 0;
            int rgb[3] = {0, 0, 0};
            if (has) {
                double r, g, bl;
                f.FaceColor().GetRGB().Values(r, g, bl, Quantity_TOC_sRGB);
                rgb[0] = (int)(r * 255 + 0.5);
                rgb[1] = (int)(g * 255 + 0.5);
                rgb[2] = (int)(bl * 255 + 0.5);
            }
            auto key = std::make_tuple(node_no, has, rgb[0], rgb[1], rgb[2]);
            auto it = index.find(key);
            if (it == index.end()) {
                it = index.emplace(key, parts.size()).first;
                parts.emplace_back();
                Part &p = parts.back();
                p.name = name;
                p.has_colour = has;
                for (int c = 0; c < 3; c++) p.rgb[c] = (uint8_t)rgb[c];
            }
            std::vector<float> &out = parts[it->second].tris;
            for (int e = f.ElemLower(); e <= f.ElemUpper(); e++) {
                Standard_Integer n[3];
                f.TriangleOriented(e).Get(n[0], n[1], n[2]);
                for (int k = 0; k < 3; k++) {
                    gp_Pnt p = f.NodeTransformed(n[k]);
                    out.push_back((float)p.X());
                    out.push_back((float)p.Y());
                    out.push_back((float)p.Z());
                }
            }
        }
    }
    // Drop empty groups (faces without triangulation).
    std::vector<Part> kept;
    for (Part &p : parts)
        if (!p.tris.empty())
            kept.push_back(std::move(p));
    return kept;
}

void quiet_occt()
{
    static bool done = false;
    if (done)
        return;
    done = true;
    // OCCT prints warnings to stdout by default; a thumbnailer must stay silent.
    Handle(Message_Messenger) m = Message::DefaultMessenger();
    m->RemovePrinters(STANDARD_TYPE(Message_Printer));
}

} // namespace

struct MpCad {
    std::vector<Part> parts;
};

extern "C" {

// Load a CAD/mesh file. format: 1 STEP, 2 IGES, 3 glTF/GLB, 4 OBJ. fine: mesh
// B-rep formats for close-up viewing rather than thumbnails.
// Returns NULL if the file can't be read or has no renderable geometry.
MpCad *mp_cad_load(const char *path, int format, int fine)
{
    try {
        quiet_occt();
        Handle(TDocStd_Document) doc;
        if (!read_document(path, format, doc) || doc.IsNull())
            return nullptr;
        if (format == FMT_STEP || format == FMT_IGES)
            mesh_document(doc, fine != 0);
        MpCad *cad = new MpCad;
        cad->parts = collect(doc);
        XCAFApp_Application::GetApplication()->Close(doc);
        if (cad->parts.empty()) {
            delete cad;
            return nullptr;
        }
        return cad;
    } catch (const Standard_Failure &) {
        return nullptr;
    } catch (const std::exception &) {
        return nullptr;
    }
}

int mp_cad_nparts(const MpCad *cad)
{
    return cad ? (int)cad->parts.size() : 0;
}

// Part i: returns its triangle count; *tris points at 9 floats per triangle
// (valid until mp_cad_free). rgb/has_colour give its colour, *name its name.
long mp_cad_part(const MpCad *cad, int i, const float **tris, uint8_t *rgb, int *has_colour,
                 const char **name)
{
    if (!cad || i < 0 || i >= (int)cad->parts.size())
        return 0;
    const Part &p = cad->parts[i];
    *tris = p.tris.data();
    memcpy(rgb, p.rgb, 3);
    *has_colour = p.has_colour;
    *name = p.name.c_str();
    return (long)(p.tris.size() / 9);
}

void mp_cad_free(MpCad *cad)
{
    delete cad;
}

} // extern "C"

#ifdef OMA_PEEK_CAD_MAIN
// Viewer format "mpk": "MPK1", u32 JSON length, JSON header, padding to 4 bytes,
// then each part's float32 triangles in order.
//   {"parts":[{"name":..,"color":"#rrggbb"|null,"n":triangles}, ...]}

static std::string json_escape(const std::string &s)
{
    std::string o;
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
        else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
    return o;
}

static int format_of(const char *path)
{
    std::string p(path);
    std::string ext = p.substr(p.find_last_of('.') + 1);
    for (char &c : ext) c = (char)tolower((unsigned char)c);
    if (ext == "step" || ext == "stp") return FMT_STEP;
    if (ext == "iges" || ext == "igs") return FMT_IGES;
    if (ext == "gltf" || ext == "glb") return FMT_GLTF;
    if (ext == "obj") return FMT_OBJ;
    return 0;
}

int main(int argc, char **argv)
{
    if (argc != 3) {
        fprintf(stderr, "usage: oma-peek-cad IN OUT.mpk\n");
        return 2;
    }
    int fmt = format_of(argv[1]);
    MpCad *cad = fmt ? mp_cad_load(argv[1], fmt, 1) : nullptr;
    if (!cad) {
        fprintf(stderr, "oma-peek-cad: could not read %s\n", argv[1]);
        return 1;
    }
    std::string json = "{\"parts\":[";
    for (size_t i = 0; i < cad->parts.size(); i++) {
        const Part &p = cad->parts[i];
        char col[16] = "null";
        if (p.has_colour)
            snprintf(col, sizeof col, "\"#%02x%02x%02x\"", p.rgb[0], p.rgb[1], p.rgb[2]);
        json += (i ? "," : "") + std::string("{\"name\":\"") + json_escape(p.name) + "\",\"color\":" + col +
                ",\"n\":" + std::to_string(p.tris.size() / 9) + "}";
    }
    json += "]}";
    while ((json.size() + 8) % 4) json += ' ';
    FILE *f = fopen(argv[2], "wb");
    if (!f)
        return 1;
    uint32_t len = (uint32_t)json.size();
    fwrite("MPK1", 1, 4, f);
    fwrite(&len, 4, 1, f);
    fwrite(json.data(), 1, json.size(), f);
    for (const Part &p : cad->parts)
        fwrite(p.tris.data(), sizeof(float), p.tris.size(), f);
    int ok = fclose(f) == 0;
    mp_cad_free(cad);
    return ok ? 0 : 1;
}
#endif
