#!/usr/bin/env python3
"""Builds the repaired file from untrunc '-plan' output, the way the browser does.

usage: assemble-plan.py <headers file> <plan.json> <damaged file> <output>

The output is the headers file (ftyp + moov + mdat header) followed by the listed
(offset, length) ranges of the damaged file, in order.
"""
import json
import os
import sys


def main(headers, plan_path, source, output):
    plan = json.load(open(plan_path))
    assert plan["version"] == 1
    assert os.path.getsize(headers) == plan["header_size"], "header size mismatch"
    assert os.path.getsize(source) == plan["source_size"], "source size mismatch"
    with open(output, "wb") as out, open(source, "rb") as src:
        out.write(open(headers, "rb").read())
        for off, length in plan["ranges"]:
            src.seek(off)
            left = length
            while left:
                block = src.read(min(left, 8 << 20))
                if not block:
                    sys.exit(f"source ended early at range {off}+{length}")
                out.write(block)
                left -= len(block)
    size = os.path.getsize(output)
    assert size == plan["total_size"], f"size {size} != planned {plan['total_size']}"
    print(f"{output}: {size} bytes from {len(plan['ranges'])} ranges")


if __name__ == "__main__":
    main(*sys.argv[1:5])
