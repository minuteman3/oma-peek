// oma-peek native rasterizer: z-buffered flat-colour triangle fill.
//
// Projection and shading happen in numpy (thumbnailer.py); this only fills
// triangles already in pixel space. Built as a shared library that
// thumbnailer.py loads from memory, since the thumbnail sandbox can only see /usr.
//
//   xs, ys  pixel coordinates, 3 per triangle
//   zs      depth, larger = closer to the camera
//   rgb     colour per triangle
//   out     w*h RGBA, zeroed by the caller
//   zbuf    w*h floats, filled with -FLT_MAX by the caller

#include <math.h>
#include <stdint.h>

static inline float edge(float ax, float ay, float bx, float by, float px, float py)
{
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

int mp_raster(int n, const float *xs, const float *ys, const float *zs,
              const uint8_t *rgb, int w, int h, uint8_t *out, float *zbuf)
{
    int drawn = 0;
    for (int t = 0; t < n; t++) {
        float x0 = xs[t * 3], x1 = xs[t * 3 + 1], x2 = xs[t * 3 + 2];
        float y0 = ys[t * 3], y1 = ys[t * 3 + 1], y2 = ys[t * 3 + 2];
        float z0 = zs[t * 3], z1 = zs[t * 3 + 1], z2 = zs[t * 3 + 2];

        float area = edge(x0, y0, x1, y1, x2, y2);
        if (area == 0.0f || !isfinite(area))
            continue;
        // Double-sided: normalise winding so inside tests are >= 0.
        if (area < 0) {
            float tx = x1, ty = y1, tz = z1;
            x1 = x2; y1 = y2; z1 = z2;
            x2 = tx; y2 = ty; z2 = tz;
            area = -area;
        }

        int minx = (int)floorf(fminf(x0, fminf(x1, x2)));
        int maxx = (int)ceilf(fmaxf(x0, fmaxf(x1, x2)));
        int miny = (int)floorf(fminf(y0, fminf(y1, y2)));
        int maxy = (int)ceilf(fmaxf(y0, fmaxf(y1, y2)));
        if (minx < 0) minx = 0;
        if (miny < 0) miny = 0;
        if (maxx > w - 1) maxx = w - 1;
        if (maxy > h - 1) maxy = h - 1;
        if (minx > maxx || miny > maxy)
            continue;

        float inv = 1.0f / area;
        uint8_t r = rgb[t * 3], g = rgb[t * 3 + 1], b = rgb[t * 3 + 2];

        // Sub-pixel triangle that covers no pixel centre: splat it so dense
        // meshes don't drop out at small sizes.
        if (maxx - minx <= 1 && maxy - miny <= 1 && area < 1.0f) {
            int px = (int)((x0 + x1 + x2) / 3), py = (int)((y0 + y1 + y2) / 3);
            if (px >= 0 && px < w && py >= 0 && py < h) {
                float z = (z0 + z1 + z2) / 3;
                long i = (long)py * w + px;
                if (z > zbuf[i]) {
                    zbuf[i] = z;
                    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
                    drawn++;
                }
            }
            continue;
        }

        for (int py = miny; py <= maxy; py++) {
            float cy = py + 0.5f;
            for (int px = minx; px <= maxx; px++) {
                float cx = px + 0.5f;
                float w0 = edge(x1, y1, x2, y2, cx, cy);
                float w1 = edge(x2, y2, x0, y0, cx, cy);
                float w2 = edge(x0, y0, x1, y1, cx, cy);
                if (w0 < 0 || w1 < 0 || w2 < 0)
                    continue;
                float z = (w0 * z0 + w1 * z1 + w2 * z2) * inv;
                long i = (long)py * w + px;
                if (z > zbuf[i]) {
                    zbuf[i] = z;
                    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
                    drawn++;
                }
            }
        }
    }
    return drawn;
}

// --- 3MF <mesh> parsing ---------------------------------------------------------
//
// Scans a mesh body for <vertex x= y= z=> and <triangle v1= v2= v3=> tags.
// Call with NULL outputs to count, then again with buffers sized from the counts.

#include <stdlib.h>
#include <string.h>

static const char *attr(const char *p, const char *end, const char *name)
{
    size_t n = strlen(name);
    for (; p + n + 2 < end; p++) {
        if (*p == '>')
            return NULL;
        if ((p[-1] == ' ' || p[-1] == '\t' || p[-1] == '\n' || p[-1] == '\r') &&
            memcmp(p, name, n) == 0 && p[n] == '=' && p[n + 1] == '"')
            return p + n + 2;
    }
    return NULL;
}

int mp_parse_mesh(const char *buf, long len, float *verts, long *nverts,
                  int64_t *tris, long *ntris)
{
    const char *p = buf, *end = buf + len;
    long nv = 0, nt = 0;
    while ((p = memchr(p, '<', end - p)) != NULL) {
        p++;
        if (end - p > 7 && memcmp(p, "vertex", 6) == 0 && (p[6] == ' ' || p[6] == '\t' || p[6] == '\n')) {
            if (verts) {
                const char *x = attr(p + 6, end, "x"), *y = attr(p + 6, end, "y"), *z = attr(p + 6, end, "z");
                verts[nv * 3] = x ? strtof(x, NULL) : 0;
                verts[nv * 3 + 1] = y ? strtof(y, NULL) : 0;
                verts[nv * 3 + 2] = z ? strtof(z, NULL) : 0;
            }
            nv++;
        } else if (end - p > 9 && memcmp(p, "triangle", 8) == 0 && (p[8] == ' ' || p[8] == '\t' || p[8] == '\n')) {
            const char *a = attr(p + 8, end, "v1"), *b = attr(p + 8, end, "v2"), *c = attr(p + 8, end, "v3");
            if (a && b && c) {
                if (tris) {
                    tris[nt * 3] = strtoll(a, NULL, 10);
                    tris[nt * 3 + 1] = strtoll(b, NULL, 10);
                    tris[nt * 3 + 2] = strtoll(c, NULL, 10);
                }
                nt++;
            }
        }
    }
    *nverts = nv;
    *ntris = nt;
    return 0;
}
