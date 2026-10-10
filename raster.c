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
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
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
