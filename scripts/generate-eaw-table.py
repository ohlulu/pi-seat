#!/usr/bin/env python3
"""Regenerate src/usage/eaw-wide.ts from Python's unicodedata (see DEC-004).

The legacy seat measures cells with unicodedata.east_asian_width; extracting
its W/F ranges into TS makes cellWidth parity hold by construction.
"""

import unicodedata

ranges = []
start = None
for cp in range(0x110000):
    wide = unicodedata.east_asian_width(chr(cp)) in ("W", "F")
    if wide and start is None:
        start = cp
    elif not wide and start is not None:
        ranges.append((start, cp - 1))
        start = None
if start is not None:
    ranges.append((start, 0x10FFFF))

with open("src/usage/eaw-wide.ts", "w") as f:
    f.write("// GENERATED — do not edit. East Asian Width W/F codepoint ranges extracted\n")
    f.write("// from the same Python unicodedata (v%s) the legacy seat renders with,\n" % unicodedata.unidata_version)
    f.write("// so cellWidth parity holds by construction. Regenerate with the script\n")
    f.write("// in scripts/generate-eaw-table.py.\n")
    f.write("export const EAW_WIDE_RANGES: readonly (readonly [number, number])[] = [\n")
    for a, b in ranges:
        f.write("\t[0x%X, 0x%X],\n" % (a, b))
    f.write("];\n")
print("wrote src/usage/eaw-wide.ts (%d ranges)" % len(ranges))
