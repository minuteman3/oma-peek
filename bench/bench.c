// Benchmark + reference dump for raster.c. Build: gcc $(cat cflags) bench/bench.c raster.c -lm -lpthread
#define _GNU_SOURCE
#include <float.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

int mp_raster(int n, const float *xs, const float *ys, const float *zs, const uint8_t *rgb, int w, int h, uint8_t *out, float *zbuf);
int mp_parse_mesh(const char *buf, long len, float *verts, long *nverts, int64_t *tris, long *ntris);

static char *slurp(const char *p, long *len)
{
    FILE *f = fopen(p, "rb");
    if (!f) { perror(p); exit(2); }
    fseek(f, 0, SEEK_END); *len = ftell(f); fseek(f, 0, SEEK_SET);
    char *b = malloc(*len + 1);
    if (fread(b, 1, *len, f) != (size_t)*len) exit(2);
    b[*len] = 0; fclose(f);
    return b;
}

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }

int main(int argc, char **argv)
{
    const char *dir = argc > 1 ? argv[1] : "bench/data";
    const char *dump = argc > 2 ? argv[2] : NULL;   // write outputs here instead of timing repeatedly
    int reps = dump ? 1 : 7;
    char path[512];
    double raster_ms = 0, parse_ms = 0;

    for (int c = 0; c < 4; c++) {
        long len; snprintf(path, sizeof path, "%s/raster%d.bin", dir, c);
        char *b = slurp(path, &len);
        int n = ((int32_t *)b)[0], res = ((int32_t *)b)[1];
        float *xs = (float *)(b + 8), *ys = xs + 3L * n, *zs = ys + 3L * n;
        uint8_t *rgb = (uint8_t *)(zs + 3L * n);
        uint8_t *out = malloc((size_t)res * res * 4);
        float *zb = malloc((size_t)res * res * 4);
        double best = 1e18;
        for (int r = 0; r < reps; r++) {
            // Caller-side init is part of the contract (thumbnailer.py does it in numpy), not timed.
            memset(out, 0, (size_t)res * res * 4);
            for (long i = 0; i < (long)res * res; i++) zb[i] = -FLT_MAX;
            double t = now();
            mp_raster(n, xs, ys, zs, rgb, res, res, out, zb);
            t = now() - t;
            if (t < best) best = t;
        }
        raster_ms += best;
        if (dump) {
            snprintf(path, sizeof path, "%s/raster%d.rgba", dump, c);
            FILE *f = fopen(path, "wb"); fwrite(out, 1, (size_t)res * res * 4, f); fclose(f);
        }
        printf("raster%d n=%d res=%d %.2f ms\n", c, n, res, best);
        free(out); free(zb); free(b);
    }
    for (int c = 0; c < 2; c++) {
        long len; snprintf(path, sizeof path, "%s/mesh%d.xml", dir, c);
        char *b = slurp(path, &len);
        double best = 1e18;
        long nv = 0, nt = 0;
        float *v = NULL; int64_t *t3 = NULL;
        for (int r = 0; r < reps; r++) {
            double t = now();
            mp_parse_mesh(b, len, NULL, &nv, NULL, &nt);
            v = realloc(v, nv * 12 + 16); t3 = realloc(t3, nt * 24 + 16);
            mp_parse_mesh(b, len, v, &nv, t3, &nt);
            t = now() - t;
            if (t < best) best = t;
        }
        parse_ms += best;
        if (dump) {
            snprintf(path, sizeof path, "%s/mesh%d.v", dump, c);
            FILE *f = fopen(path, "wb"); fwrite(v, 4, nv * 3, f); fclose(f);
            snprintf(path, sizeof path, "%s/mesh%d.t", dump, c);
            f = fopen(path, "wb"); fwrite(t3, 8, nt * 3, f); fclose(f);
        }
        printf("mesh%d nv=%ld nt=%ld %.2f ms\n", c, nv, nt, best);
        free(v); free(t3); free(b);
    }
    printf("METRIC total_ms=%.3f\nMETRIC raster_ms=%.3f\nMETRIC parse_ms=%.3f\n", raster_ms + parse_ms, raster_ms, parse_ms);
    return 0;
}
