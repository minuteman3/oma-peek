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

#include <float.h>
#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static inline float edge(float ax, float ay, float bx, float by, float px, float py)
{
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

typedef struct {
    int n;
    const float *xs, *ys, *zs;
    const uint8_t *rgb;
    int w, h;
    uint8_t *out;
    float *zbuf;
    int k, nt;          // this worker owns rows whose stripe (row / STRIPE) % nt == k
    int drawn;
} Band;

// Rows are dealt out to workers in interleaved STRIPE-row stripes, which balances
// load even when the model covers only a narrow band of the image. Workers never
// share pixels, so they run concurrently without locks.
#define STRIPE 8

static inline int owns(const Band *B, int row)
{
    return (row / STRIPE) % B->nt == B->k;
}

// Rasterise triangle t, restricted to the rows this worker owns.
static inline int raster_tri(const Band *B, int t)
{
    const float *xs = B->xs, *ys = B->ys, *zs = B->zs;
    const uint8_t *rgb = B->rgb;
    int w = B->w, h = B->h;
    uint8_t *out = B->out;
    float *zbuf = B->zbuf;
    int drawn = 0;
    float y0 = ys[t * 3], y1 = ys[t * 3 + 1], y2 = ys[t * 3 + 2];
    float x0 = xs[t * 3], x1 = xs[t * 3 + 1], x2 = xs[t * 3 + 2];
    float z0 = zs[t * 3], z1 = zs[t * 3 + 1], z2 = zs[t * 3 + 2];

    float area = edge(x0, y0, x1, y1, x2, y2);
    if (area == 0.0f || !isfinite(area))
        return drawn;
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
        return drawn;

    float inv = 1.0f / area;
    uint8_t r = rgb[t * 3], g = rgb[t * 3 + 1], b = rgb[t * 3 + 2];

    // Sub-pixel triangle that covers no pixel centre: splat it so dense
    // meshes don't drop out at small sizes.
    if (maxx - minx <= 1 && maxy - miny <= 1 && area < 1.0f) {
        int px = (int)((x0 + x1 + x2) / 3), py = (int)((y0 + y1 + y2) / 3);
        if (px >= 0 && px < w && py >= 0 && py < h && owns(B, py)) {
            float z = (z0 + z1 + z2) / 3;
            long i = (long)py * w + px;
            if (z > zbuf[i]) {
                zbuf[i] = z;
                out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
                drawn++;
            }
        }
        return drawn;
    }

    // Edge functions are affine in (x, y): step them instead of re-evaluating.
    float a0 = -(y2 - y1), b0 = x2 - x1;
    float a1 = -(y0 - y2), b1 = x0 - x2;
    float a2 = -(y1 - y0), b2 = x1 - x0;
    float sx = minx + 0.5f, sy = miny + 0.5f;
    float r0 = edge(x1, y1, x2, y2, sx, sy);
    float r1 = edge(x2, y2, x0, y0, sx, sy);
    float r2 = edge(x0, y0, x1, y1, sx, sy);
    // z is affine too: z(t) = zr + dzx * t along a row.
    float dzx = (a0 * z0 + a1 * z1 + a2 * z2) * inv;
    float dzy = (b0 * z0 + b1 * z1 + b2 * z2) * inv;
    float zr = (r0 * z0 + r1 * z1 + r2 * z2) * inv;
    int span = maxx - minx;
    for (int py = miny; py <= maxy; py++, r0 += b0, r1 += b1, r2 += b2, zr += dzy) {
        if (!owns(B, py))
            continue;
        // Solve r + a*t >= 0 per edge for the covered t-range on this row.
        float lo = 0, hi = (float)span;
        float rs[3] = {r0, r1, r2}, as[3] = {a0, a1, a2};
        for (int k = 0; k < 3; k++) {
            if (as[k] > 0) {
                float t = -rs[k] / as[k];
                if (t > lo) lo = t;
            } else if (as[k] < 0) {
                float t = -rs[k] / as[k];
                if (t < hi) hi = t;
            } else if (rs[k] < 0) {
                hi = -1;
            }
        }
        if (lo > hi)
            continue;
        int t0 = (int)ceilf(lo), t1 = (int)floorf(hi);
        if (t1 > span) t1 = span;
        long row = (long)py * w + minx;
        float z = zr + dzx * t0;
        for (int t = t0; t <= t1; t++, z += dzx) {
            long i = row + t;
            if (z > zbuf[i]) {
                zbuf[i] = z;
                out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
                drawn++;
            }
        }
    }
    return drawn;
}

// Without binning: walk every triangle (single-threaded path).
static void *raster_band(void *arg)
{
    Band *B = arg;
    int drawn = 0;
    for (int t = 0; t < B->n; t++)
        drawn += raster_tri(B, t);
    B->drawn = drawn;
    return NULL;
}

// --- binning: a parallel pre-pass deals triangle indices to their owners ---

typedef struct {
    const Band *B;          // geometry + nt (k unused)
    int j, nt;              // this binner handles triangles [lo, hi)
    int lo, hi;
    int *counts;            // nt entries: triangles from this range per owner
    int32_t *idx;           // grouped by owner, sized sum(counts)
    int *offs;              // nt entries: start of each owner's group in idx
} Bin;

static inline void stripe_range(const Band *B, int t, int *s0, int *s1)
{
    const float *ys = B->ys;
    int h = B->h;
    float y0 = ys[t * 3], y1 = ys[t * 3 + 1], y2 = ys[t * 3 + 2];
    float fy0 = fminf(y0, fminf(y1, y2)), fy1 = fmaxf(y0, fmaxf(y1, y2));
    int ry0 = fy0 < 0 ? 0 : fy0 >= h ? h - 1 : (int)fy0;
    int ry1 = fy1 < 0 ? 0 : fy1 >= h ? h - 1 : (int)fy1 + 1;
    if (ry1 > h - 1) ry1 = h - 1;
    *s0 = ry0 / STRIPE;
    *s1 = ry1 / STRIPE;
}

static void *bin_count(void *arg)
{
    Bin *J = arg;
    int nt = J->nt;
    for (int k = 0; k < nt; k++) J->counts[k] = 0;
    for (int t = J->lo; t < J->hi; t++) {
        int s0, s1;
        stripe_range(J->B, t, &s0, &s1);
        if (s1 - s0 + 1 >= nt) {
            for (int k = 0; k < nt; k++) J->counts[k]++;
        } else {
            for (int st = s0; st <= s1; st++) J->counts[st % nt]++;
        }
    }
    return NULL;
}

static void *bin_fill(void *arg)
{
    Bin *J = arg;
    int nt = J->nt;
    int pos[16];
    for (int k = 0; k < nt; k++) pos[k] = J->offs[k];
    for (int t = J->lo; t < J->hi; t++) {
        int s0, s1;
        stripe_range(J->B, t, &s0, &s1);
        if (s1 - s0 + 1 >= nt) {
            for (int k = 0; k < nt; k++) J->idx[pos[k]++] = t;
        } else {
            for (int st = s0; st <= s1; st++) J->idx[pos[st % nt]++] = t;
        }
    }
    return NULL;
}

// Count, allocate and fill in one go: each binner only touches its own range,
// so no barrier is needed between counting and filling.
static void *bin_all(void *arg)
{
    Bin *J = arg;
    bin_count(J);
    long total = 0;
    for (int k = 0; k < J->nt; k++) { J->offs[k] = (int)total; total += J->counts[k]; }
    J->idx = malloc((total + 1) * sizeof(int32_t));
    if (J->idx)
        bin_fill(J);
    return NULL;
}

typedef struct {
    Band band;
    Bin *bins;              // all nt binners; owner reads its group from each, in order
} Owner;

static void *raster_owner(void *arg)
{
    Owner *O = arg;
    const Band *B = &O->band;
    int k = B->k, drawn = 0;
    for (int j = 0; j < B->nt; j++) {
        const Bin *J = &O->bins[j];
        const int32_t *p = J->idx + J->offs[k], *e = p + J->counts[k];
        for (; p < e; p++)
            drawn += raster_tri(B, *p);
    }
    O->band.drawn = drawn;
    return NULL;
}

static void run_threads(void *(*fn)(void *), void *items, size_t size, int n)
{
    pthread_t tid[16];
    int ok[16] = {0};
    for (int k = 1; k < n; k++)
        ok[k] = pthread_create(&tid[k], NULL, fn, (char *)items + k * size) == 0;
    fn(items);
    for (int k = 1; k < n; k++) {
        if (ok[k])
            pthread_join(tid[k], NULL);
        else
            fn((char *)items + k * size);
    }
}

int mp_raster(int n, const float *xs, const float *ys, const float *zs,
              const uint8_t *rgb, int w, int h, uint8_t *out, float *zbuf)
{
    enum { MAX_THREADS = 16 };
    long cpus = sysconf(_SC_NPROCESSORS_ONLN);
    int nt = cpus < 1 ? 1 : cpus > MAX_THREADS ? MAX_THREADS : (int)cpus;
    if ((long)n * 4 < 200000 && (long)w * h < 1000000)
        nt = 1;     // not worth the thread start-up
    Band base = {n, xs, ys, zs, rgb, w, h, out, zbuf, 0, 1, 0};
    if (nt == 1) {
        raster_band(&base);
        return base.drawn;
    }
    base.nt = nt;

    Bin bins[MAX_THREADS];
    int counts[MAX_THREADS][MAX_THREADS], offs[MAX_THREADS][MAX_THREADS];
    for (int j = 0; j < nt; j++)
        bins[j] = (Bin){&base, j, nt, (int)((long)n * j / nt), (int)((long)n * (j + 1) / nt),
                        counts[j], NULL, offs[j]};
    run_threads(bin_all, bins, sizeof(Bin), nt);
    int32_t *store[MAX_THREADS] = {0};
    int failed = 0;
    for (int j = 0; j < nt; j++) {
        store[j] = bins[j].idx;
        if (!store[j]) failed = 1;
    }
    int drawn = 0;
    if (failed) {
        raster_band(&base);
        drawn = base.drawn;
    } else {
        Owner owners[MAX_THREADS];
        for (int k = 0; k < nt; k++) {
            owners[k].band = base;
            owners[k].band.k = k;
            owners[k].bins = bins;
        }
        run_threads(raster_owner, owners, sizeof(Owner), nt);
        for (int k = 0; k < nt; k++)
            drawn += owners[k].band.drawn;
    }
    for (int j = 0; j < nt; j++)
        free(store[j]);
    return drawn;
}

// --- whole render: project + shade + raster ------------------------------------
//
// Replaces the numpy float64 pipeline in thumbnailer.py. Triangles are given in
// world space (printer coords, Z up), grouped into parts with one base colour each.
// Orthographic view along `view` (pointing at the camera); faces are double-sided.
//
//   nparts, counts[nparts]   triangles per part, in order
//   colours[nparts * 3]      base RGB per part (already lifted for dark filament)
//   tris[n * 9]              x,y,z of each triangle's three vertices
//   res                      output is res x res; model fills 90% of it
//   out, zbuf                as mp_raster (zeroed / -FLT_MAX by the caller)
// Returns pixels drawn, or -1 if every triangle is degenerate.

static void cross3(const double *a, const double *b, double *o)
{
    o[0] = a[1] * b[2] - a[2] * b[1];
    o[1] = a[2] * b[0] - a[0] * b[2];
    o[2] = a[0] * b[1] - a[1] * b[0];
}

static void norm3(double *v)
{
    double l = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (l > 0) { v[0] /= l; v[1] /= l; v[2] /= l; }
}

int mp_render(int nparts, const int *counts, const uint8_t *colours, const float *tris,
              int res, const double *view, const double *light_dir, uint8_t *out, float *zbuf)
{
    long n = 0;
    for (int k = 0; k < nparts; k++) n += counts[k];
    double d[3] = {view[0], view[1], view[2]}, up0[3] = {0, 0, 1}, right[3], up[3];
    double L[3] = {light_dir[0], light_dir[1], light_dir[2]};
    norm3(d); norm3(L);
    cross3(up0, d, right); norm3(right);
    cross3(d, right, up);

    float *xs = malloc(n * 3 * sizeof(float)), *ys = malloc(n * 3 * sizeof(float)), *zs = malloc(n * 3 * sizeof(float));
    uint8_t *rgb = malloc(n * 3 + 1);
    if (!xs || !ys || !zs || !rgb) {
        free(xs); free(ys); free(zs); free(rgb);
        return -2;
    }

    // Pass 1: shade and project to view space, dropping degenerate triangles.
    long m = 0, t = 0;
    double x0 = INFINITY, x1 = -INFINITY, y0 = INFINITY, y1 = -INFINITY;
    for (int k = 0; k < nparts; k++) {
        double cr = colours[k * 3], cg = colours[k * 3 + 1], cb = colours[k * 3 + 2];
        for (int c = 0; c < counts[k]; c++, t++) {
            const float *v = tris + t * 9;
            double e1[3] = {v[3] - v[0], v[4] - v[1], v[5] - v[2]};
            double e2[3] = {v[6] - v[0], v[7] - v[1], v[8] - v[2]};
            double nn[3];
            cross3(e1, e2, nn);
            double nl = sqrt(nn[0] * nn[0] + nn[1] * nn[1] + nn[2] * nn[2]);
            if (!(nl > 0))
                continue;
            nn[0] /= nl; nn[1] /= nl; nn[2] /= nl;
            double nd = nn[0] * d[0] + nn[1] * d[1] + nn[2] * d[2];
            if (nd < 0) { nn[0] = -nn[0]; nn[1] = -nn[1]; nn[2] = -nn[2]; nd = -nd; }
            double diffuse = nn[0] * L[0] + nn[1] * L[1] + nn[2] * L[2];
            diffuse = diffuse < 0 ? 0 : diffuse > 1 ? 1 : diffuse;
            double rim = nd > 1 ? 1 : nd;
            double shade = 0.42 + 0.48 * diffuse + 0.12 * rim;
            double sr = cr * shade, sg = cg * shade, sb = cb * shade;
            rgb[m * 3] = (uint8_t)(sr > 255 ? 255 : sr);
            rgb[m * 3 + 1] = (uint8_t)(sg > 255 ? 255 : sg);
            rgb[m * 3 + 2] = (uint8_t)(sb > 255 ? 255 : sb);
            for (int j = 0; j < 3; j++) {
                double px = v[j * 3], py = v[j * 3 + 1], pz = v[j * 3 + 2];
                double sx = px * right[0] + py * right[1] + pz * right[2];
                double sy = px * up[0] + py * up[1] + pz * up[2];
                xs[m * 3 + j] = (float)sx;
                ys[m * 3 + j] = (float)sy;
                zs[m * 3 + j] = (float)(px * d[0] + py * d[1] + pz * d[2]);
                if (sx < x0) x0 = sx;
                if (sx > x1) x1 = sx;
                if (sy < y0) y0 = sy;
                if (sy > y1) y1 = sy;
            }
            m++;
        }
    }
    if (m == 0) {
        free(xs); free(ys); free(zs); free(rgb);
        return -1;
    }

    // Pass 2: fit to the image (90% of the larger extent, centred).
    double span = fmax(x1 - x0, y1 - y0);
    if (!(span > 0)) span = 1.0;
    double scale = res * 0.9 / span, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    for (long i = 0; i < m * 3; i++) {
        xs[i] = (float)((xs[i] - cx) * scale + res / 2.0);
        ys[i] = (float)(res / 2.0 - (ys[i] - cy) * scale);
    }

    int drawn = mp_raster((int)m, xs, ys, zs, rgb, res, res, out, zbuf);
    free(xs); free(ys); free(zs); free(rgb);
    return drawn;
}

// --- downsample ----------------------------------------------------------------
//
// Premultiplied k x k box filter from the supersampled render (src: res x res RGBA,
// res = size * k) to dst (size x size RGBA). Same arithmetic as the numpy fallback.

void mp_downsample(const uint8_t *src, int size, int k, uint8_t *dst)
{
    int res = size * k;
    float inv = 1.0f / (k * k);
    for (int y = 0; y < size; y++) {
        for (int x = 0; x < size; x++) {
            float r = 0, g = 0, b = 0, a = 0;
            for (int j = 0; j < k; j++) {
                const uint8_t *p = src + ((long)(y * k + j) * res + x * k) * 4;
                for (int i = 0; i < k; i++, p += 4) {
                    float pa = p[3] * (1.0f / 255);
                    r += p[0] * pa; g += p[1] * pa; b += p[2] * pa; a += p[3];
                }
            }
            r *= inv; g *= inv; b *= inv; a *= inv;
            uint8_t *q = dst + ((long)y * size + x) * 4;
            if (a > 0) {
                float un = 255.0f / (a < 1 ? 1 : a);
                float vr = r * un + 0.5f, vg = g * un + 0.5f, vb = b * un + 0.5f;
                q[0] = (uint8_t)(vr > 255 ? 255 : vr);
                q[1] = (uint8_t)(vg > 255 ? 255 : vg);
                q[2] = (uint8_t)(vb > 255 ? 255 : vb);
            } else {
                q[0] = q[1] = q[2] = 0;
            }
            float va = a + 0.5f;
            q[3] = (uint8_t)(va > 255 ? 255 : va);
        }
    }
}

// --- whole thumbnail ------------------------------------------------------------
//
// render (3x supersampled) -> downsample -> composite onto the backdrop -> PNG
// scanlines (filter byte 0 + RGB per row), so a binary STL thumbnail needs no
// numpy in the Python caller. raw must hold size * (1 + 3 * size) bytes.

static void backdrop_rows(const uint8_t *im, int size, uint8_t *raw)
{
    static const float top[3] = {58, 58, 62}, bottom[3] = {34, 34, 38};
    for (int y = 0; y < size; y++) {
        float t = size > 1 ? (float)y / (size - 1) : 0;
        float bg[3];
        for (int c = 0; c < 3; c++) bg[c] = top[c] * (1 - t) + bottom[c] * t;
        uint8_t *row = raw + (long)y * (1 + 3 * size);
        row[0] = 0;
        for (int x = 0; x < size; x++) {
            const uint8_t *p = im + ((long)y * size + x) * 4;
            float a = p[3] / 255.0f;
            for (int c = 0; c < 3; c++) {
                float v = p[c] * a + bg[c] * (1 - a) + 0.5f;
                row[1 + x * 3 + c] = (uint8_t)(v > 255 ? 255 : v);
            }
        }
    }
}

// Render + downsample to a size x size RGBA image (transparent background).
// Returns 0, -1 if every triangle is degenerate, -2 on allocation failure.
int mp_render_rgba(int nparts, const int *counts, const uint8_t *colours, const float *tris,
                   int size, const double *view, const double *light, uint8_t *rgba)
{
    int k = 3, res = size * k;
    uint8_t *out = calloc((size_t)res * res, 4);
    float *zbuf = malloc((size_t)res * res * sizeof(float));
    if (!out || !zbuf) {
        free(out); free(zbuf);
        return -2;
    }
    for (long i = 0; i < (long)res * res; i++) zbuf[i] = -FLT_MAX;
    int r = mp_render(nparts, counts, colours, tris, res, view, light, out, zbuf);
    if (r >= 0) {
        mp_downsample(out, size, k, rgba);
        r = 0;
    }
    free(out); free(zbuf);
    return r;
}

void mp_backdrop(const uint8_t *rgba, int size, uint8_t *raw)
{
    backdrop_rows(rgba, size, raw);
}

int mp_thumb(int nparts, const int *counts, const uint8_t *colours, const float *tris,
             int size, const double *view, const double *light, uint8_t *raw)
{
    uint8_t *small = malloc((size_t)size * size * 4);
    if (!small)
        return -2;
    int r = mp_render_rgba(nparts, counts, colours, tris, size, view, light, small);
    if (r == 0)
        backdrop_rows(small, size, raw);
    free(small);
    return r;
}

// Apply a 3MF affine transform (row-vector convention: 3x3 then translation,
// 12 doubles) to a mesh and gather its triangles as 9 floats each. Triangles with
// out-of-range indices are skipped. Returns triangles written.
long mp_emit(const float *v, long nv, const int64_t *t, long nt, const double *m, float *out)
{
    long w = 0;
    for (long i = 0; i < nt; i++) {
        int64_t a = t[i * 3], b = t[i * 3 + 1], c = t[i * 3 + 2];
        if (a < 0 || b < 0 || c < 0 || a >= nv || b >= nv || c >= nv)
            continue;
        int64_t idx[3] = {a, b, c};
        float *o = out + w * 9;
        for (int j = 0; j < 3; j++) {
            const float *p = v + idx[j] * 3;
            double x = p[0], y = p[1], z = p[2];
            o[j * 3] = (float)(x * m[0] + y * m[3] + z * m[6] + m[9]);
            o[j * 3 + 1] = (float)(x * m[1] + y * m[4] + z * m[7] + m[10]);
            o[j * 3 + 2] = (float)(x * m[2] + y * m[5] + z * m[8] + m[11]);
        }
        w++;
    }
    return w;
}

// Binary STL straight from the file bytes. Returns -3 if it isn't binary STL
// (the caller then uses the general path, e.g. for ASCII STL).
int mp_thumb_stl(const uint8_t *data, long len, const uint8_t *colour, int size,
                 const double *view, const double *light, uint8_t *raw)
{
    if (len < 84)
        return -3;
    uint32_t n;
    memcpy(&n, data + 80, 4);
    if (n == 0 || (long)n * 50 + 84 != len)
        return -3;
    float *tris = malloc((size_t)n * 36);
    if (!tris)
        return -2;
    for (uint32_t i = 0; i < n; i++)
        memcpy(tris + (size_t)i * 9, data + 84 + (size_t)i * 50 + 12, 36);
    int count = (int)n;
    int r = mp_thumb(1, &count, colour, tris, size, view, light, raw);
    free(tris);
    return r;
}

// --- inflate via libdeflate -------------------------------------------------------
//
// libdeflate decompresses whole buffers 2-3x faster than zlib. It is dlopen'd at
// runtime so a system without it just gets -1 and the caller falls back to zlib.
// Raw DEFLATE (as stored in zip members). Returns bytes written, or -1.

#include <dlfcn.h>

typedef void *(*deflate_alloc_fn)(void);
typedef int (*deflate_decompress_fn)(void *, const void *, size_t, void *, size_t, size_t *);

long mp_inflate(const void *src, long srclen, void *dst, long dstlen)
{
    static void *dec;
    static deflate_decompress_fn decompress;
    static int tried;
    if (!tried) {
        tried = 1;
        void *h = dlopen("libdeflate.so.0", RTLD_NOW | RTLD_LOCAL);
        if (h) {
            deflate_alloc_fn alloc = (deflate_alloc_fn)dlsym(h, "libdeflate_alloc_decompressor");
            decompress = (deflate_decompress_fn)dlsym(h, "libdeflate_deflate_decompress");
            if (alloc && decompress)
                dec = alloc();
        }
    }
    if (!dec)
        return -1;
    size_t got = 0;
    if (decompress(dec, src, (size_t)srclen, dst, (size_t)dstlen, &got) != 0)
        return -1;
    return (long)got;
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

static const double POW10[] = {1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11,
                               1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22};

// Plain decimal floats ("-12.345", "1e-3"); anything unusual falls back to strtof.
static float parse_float_end(const char *s, const char **endp)
{
    const char *p = s;
    int neg = 0;
    if (*p == '-') { neg = 1; p++; } else if (*p == '+') p++;
    uint64_t m = 0;
    int digits = 0, exp = 0;
    while ((unsigned)(*p - '0') < 10) {
        if (digits < 19) { m = m * 10 + (*p - '0'); digits++; } else exp++;
        p++;
    }
    if (*p == '.') {
        p++;
        while ((unsigned)(*p - '0') < 10) {
            if (digits < 19) { m = m * 10 + (*p - '0'); digits++; exp--; }
            p++;
        }
    }
    if (*p == 'e' || *p == 'E') {
        p++;
        int eneg = 0, e = 0;
        if (*p == '-') { eneg = 1; p++; } else if (*p == '+') p++;
        if ((unsigned)(*p - '0') >= 10)
            return strtof(s, (char **)endp);
        while ((unsigned)(*p - '0') < 10) { if (e < 10000) e = e * 10 + (*p - '0'); p++; }
        exp += eneg ? -e : e;
    }
    if (digits == 0 || exp < -22 || exp > 22 || m > (1ULL << 53))
        return strtof(s, (char **)endp);
    *endp = p;
    double v = exp < 0 ? (double)m / POW10[-exp] : (double)m * POW10[exp];
    return (float)(neg ? -v : v);
}

static float parse_float(const char *s)
{
    const char *e;
    return parse_float_end(s, &e);
}

// Fast path for the canonical layout ` x="…" y="…" z="…"` that every slicer writes.
static int vertex_fast(const char *p, const char *end, float *v)
{
    static const char *names[3] = {" x=\"", " y=\"", " z=\""};
    for (int k = 0; k < 3; k++) {
        if (end - p < 6 || memcmp(p, names[k], 4) != 0)
            return 0;
        p += 4;
        const char *e;
        v[k] = parse_float_end(p, &e);
        if (e == p || *e != '"')
            return 0;
        p = e + 1;
    }
    return 1;
}

static int triangle_fast(const char *p, const char *end, int64_t *t)
{
    static const char *names[3] = {" v1=\"", " v2=\"", " v3=\""};
    for (int k = 0; k < 3; k++) {
        if (end - p < 7 || memcmp(p, names[k], 5) != 0)
            return 0;
        p += 5;
        int64_t v = 0;
        const char *s = p;
        while ((unsigned)(*p - '0') < 10) v = v * 10 + (*p++ - '0');
        if (p == s || *p != '"')
            return 0;
        t[k] = v;
        p++;
    }
    return 1;
}

static int64_t parse_int(const char *p)
{
    int64_t v = 0;
    while ((unsigned)(*p - '0') < 10) v = v * 10 + (*p++ - '0');
    return v;
}

// Output sink for scan_chunk: fixed caller arrays, growable owned arrays, or
// count-only (v and t NULL, grow 0).
typedef struct {
    float *v;
    int64_t *t;
    long vcap, tcap;
    int grow;
} Sink;

static int sink_room(Sink *o, long nv, long nt)
{
    if (!o->grow)
        return 1;
    if (nv >= o->vcap) {
        long cap = o->vcap ? o->vcap * 2 : 4096;
        float *v = realloc(o->v, cap * 3 * sizeof(float));
        if (!v) return 0;
        o->v = v; o->vcap = cap;
    }
    if (nt >= o->tcap) {
        long cap = o->tcap ? o->tcap * 2 : 8192;
        int64_t *t = realloc(o->t, cap * 3 * sizeof(int64_t));
        if (!t) return 0;
        o->t = t; o->tcap = cap;
    }
    return 1;
}

// Scan tags that start in [p, stop); a tag may run on past stop up to end.
// Returns 0 if a growable sink ran out of memory.
static int scan_chunk(const char *p, const char *stop, const char *end, Sink *o,
                      long *nverts, long *ntris)
{
    long nv = 0, nt = 0;
    while (p < stop && (p = memchr(p, '<', stop - p)) != NULL) {
        p++;
        if (!sink_room(o, nv, nt))
            return 0;
        float *verts = o->v;
        int64_t *tris = o->t;
        if (end - p > 7 && memcmp(p, "vertex", 6) == 0 && (p[6] == ' ' || p[6] == '\t' || p[6] == '\n')) {
            float fv[3];
            if (verts && vertex_fast(p + 6, end, fv)) {
                verts[nv * 3] = fv[0]; verts[nv * 3 + 1] = fv[1]; verts[nv * 3 + 2] = fv[2];
            } else if (verts) {
                const char *x = attr(p + 6, end, "x"), *y = attr(p + 6, end, "y"), *z = attr(p + 6, end, "z");
                verts[nv * 3] = x ? parse_float(x) : 0;
                verts[nv * 3 + 1] = y ? parse_float(y) : 0;
                verts[nv * 3 + 2] = z ? parse_float(z) : 0;
            }
            nv++;
        } else if (end - p > 9 && memcmp(p, "triangle", 8) == 0 && (p[8] == ' ' || p[8] == '\t' || p[8] == '\n')) {
            int64_t ft[3];
            if (triangle_fast(p + 8, end, ft)) {
                if (tris) { tris[nt * 3] = ft[0]; tris[nt * 3 + 1] = ft[1]; tris[nt * 3 + 2] = ft[2]; }
                nt++;
                continue;
            }
            const char *a = attr(p + 8, end, "v1"), *b = attr(p + 8, end, "v2"), *c = attr(p + 8, end, "v3");
            if (a && b && c) {
                if (tris) {
                    tris[nt * 3] = parse_int(a);
                    tris[nt * 3 + 1] = parse_int(b);
                    tris[nt * 3 + 2] = parse_int(c);
                }
                nt++;
            }
        }
    }
    *nverts = nv;
    *ntris = nt;
    return 1;
}

typedef struct {
    const char *start, *stop, *end;
    Sink sink;              // owned arrays filled during the counting call
    int ok;
    float *verts;           // destination slices in the caller's arrays
    int64_t *tris;
    long nv, nt;
} Chunk;

// Counting call: parse fully into owned buffers so the fill call is just a copy.
static void *parse_chunk(void *arg)
{
    Chunk *c = arg;
    c->sink = (Sink){NULL, NULL, 0, 0, 1};
    c->ok = scan_chunk(c->start, c->stop, c->end, &c->sink, &c->nv, &c->nt);
    return NULL;
}

static void *copy_chunk(void *arg)
{
    Chunk *c = arg;
    if (c->verts) memcpy(c->verts, c->sink.v, c->nv * 3 * sizeof(float));
    if (c->tris) memcpy(c->tris, c->sink.t, c->nt * 3 * sizeof(int64_t));
    return NULL;
}

// Fallback when the owned buffers are unavailable: rescan straight into the caller's arrays.
static void *fill_chunk(void *arg)
{
    Chunk *c = arg;
    Sink o = {c->verts, c->tris, 0, 0, 0};
    long nv, nt;
    scan_chunk(c->start, c->stop, c->end, &o, &nv, &nt);
    return NULL;
}

static void run_all(void *(*fn)(void *), Chunk *cs, int n)
{
    pthread_t tid[16];
    int ok[16] = {0};
    for (int k = 1; k < n; k++)
        ok[k] = pthread_create(&tid[k], NULL, fn, &cs[k]) == 0;
    fn(&cs[0]);
    for (int k = 1; k < n; k++) {
        if (ok[k])
            pthread_join(tid[k], NULL);
        else
            fn(&cs[k]);
    }
}

static void free_chunks(Chunk *cs, int n)
{
    for (int k = 0; k < n; k++) {
        free(cs[k].sink.v);
        free(cs[k].sink.t);
        cs[k].sink.v = NULL;
        cs[k].sink.t = NULL;
    }
}

int mp_parse_mesh(const char *buf, long len, float *verts, long *nverts,
                  int64_t *tris, long *ntris)
{
    const char *end = buf + len;
    long cpus = sysconf(_SC_NPROCESSORS_ONLN);
    int n = len < (4L << 20) ? 1 : cpus < 1 ? 1 : cpus > 16 ? 16 : (int)cpus;

    if (n == 1) {
        Sink o = {verts, tris, 0, 0, 0};
        scan_chunk(buf, end, end, &o, nverts, ntris);
        return 0;
    }

    // Callers count first (NULL outputs), then fill the same buffer. The counting
    // call parses everything into per-chunk buffers kept here; the fill call copies
    // them out. Keyed on pointer, length and a sampled fingerprint.
    static __thread struct { const char *buf; long len; uint64_t fp; int n; Chunk cs[16]; } memo;
    uint64_t fp = 1469598103934665603ULL;   // FNV-1a over 64 sampled bytes
    for (int i = 0; i < 64; i++)
        fp = (fp ^ (uint8_t)buf[len / 64 * i]) * 1099511628211ULL;
    int fill = verts || tris;
    int cached = memo.buf == buf && memo.len == len && memo.fp == fp && memo.n == n;

    if (!cached) {
        if (memo.buf)
            free_chunks(memo.cs, memo.n);
        memo.buf = NULL;
        // Chunk boundaries snap forward to a '<' so no tag is split between chunks.
        Chunk *cs = memo.cs;
        const char *prev = buf;
        for (int k = 0; k < n; k++) {
            const char *stop = end;
            if (k < n - 1) {
                stop = buf + len / n * (k + 1);
                if (stop < prev) stop = prev;
                const char *lt = memchr(stop, '<', end - stop);
                stop = lt ? lt : end;
            }
            cs[k] = (Chunk){prev, stop, end};
            prev = stop;
        }
        run_all(parse_chunk, cs, n);
        for (int k = 0; k < n; k++)
            if (!cs[k].ok) {    // out of memory: counts are partial, recount without storing
                Sink none = {NULL, NULL, 0, 0, 0};
                scan_chunk(cs[k].start, cs[k].stop, cs[k].end, &none, &cs[k].nv, &cs[k].nt);
            }
        memo.buf = buf; memo.len = len; memo.fp = fp; memo.n = n;
    }

    Chunk *cs = memo.cs;
    int all_ok = 1;
    long nv = 0, nt = 0;
    for (int k = 0; k < n; k++) {
        all_ok &= cs[k].ok;
        cs[k].verts = verts ? verts + nv * 3 : NULL;
        cs[k].tris = tris ? tris + nt * 3 : NULL;
        nv += cs[k].nv;
        nt += cs[k].nt;
    }
    if (fill) {
        run_all(all_ok ? copy_chunk : fill_chunk, cs, n);
        free_chunks(cs, n);     // one fill per count; the buffer may be freed after this
        memo.buf = NULL;
    }
    *nverts = nv;
    *ntris = nt;
    return 0;
}
