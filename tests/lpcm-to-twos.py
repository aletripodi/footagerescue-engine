#!/usr/bin/env python3
"""Relabels the 16-bit big-endian PCM track of a test clip from 'lpcm' to 'twos'.

AVFoundation writes big-endian 16-bit PCM as 'lpcm'; Sony cameras label the same
samples 'twos', which is what untrunc '-rsv-ben' looks for. Only the sample entry
inside moov/trak/mdia/minf/stbl/stsd is changed, in place.
"""
import struct
import sys

CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl"}


def walk(f, start, end, path):
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        size, name = struct.unpack(">I4s", f.read(8))
        header = 8
        if size == 1:
            size = struct.unpack(">Q", f.read(8))[0]
            header = 16
        elif size == 0:
            size = end - pos
        if name in CONTAINERS:
            yield from walk(f, pos + header, pos + size, path + [name])
        elif name == b"stsd":
            # full box: version/flags (4) + entry count (4), then entries
            f.seek(pos + header + 4)
            count = struct.unpack(">I", f.read(4))[0]
            entry = pos + header + 8
            for _ in range(count):
                f.seek(entry)
                esize, fourcc = struct.unpack(">I4s", f.read(8))
                yield entry + 4, fourcc
                entry += esize
        pos += size


def main(path):
    with open(path, "r+b") as f:
        f.seek(0, 2)
        changed = 0
        for off, fourcc in list(walk(f, 0, f.tell(), [])):
            if fourcc == b"lpcm":
                f.seek(off)
                f.write(b"twos")
                changed += 1
    if changed != 1:
        sys.exit(f"expected exactly one 'lpcm' sample entry, changed {changed}")
    print(f"{path}: lpcm -> twos")


if __name__ == "__main__":
    main(sys.argv[1])
