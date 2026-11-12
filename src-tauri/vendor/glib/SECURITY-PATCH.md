# GLib security backport

This is crates.io glib 0.18.5, with only the two-line mutable out-pointer fix in src/variant_iter.rs from upstream https://github.com/gtk-rs/gtk-rs-core/pull/1343 applied. Original license files are preserved.

This fixes RUSTSEC-2024-0429 without changing the GTK3 ABI required by Tauri. Version-based scanners may still flag 0.18.5; do not suppress the advisory globally. Remove this patch when the desktop stack supports a fixed upstream series. The application has an optimized regression test for the affected iterator.

Original crates.io package SHA-256: `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`. The source version is deliberately unchanged; this is a documented backport, not an upstream 0.20 upgrade.
