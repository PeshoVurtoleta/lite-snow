/**
 * T5 -- differential fuzz against a plain-object oracle. PLACEHOLDER.
 *
 * Filled in S3: a one-object-per-particle reference implementation driven by the
 * same seeded rng and frame schedule; after every frame the sorted live
 * (x, y, radius, state) tuples must match exactly. This is the tier that protects
 * S3's ring-cursor and binning rewrites (SN-12/13/14): a hot-path rewrite must
 * change cost, never answers. Registered now so the tier order is stable.
 */

export function run() {
    // Intentionally empty in S0.
}
