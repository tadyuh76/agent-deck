#!/usr/bin/env python3
"""Makes a Mach-O executable load one more library at launch.

Adds a load command for the library to every architecture of the file, in the
free space between the existing load commands and the code. Remove the code
signature first and sign again afterwards.
Usage: add-library.py <executable> <library install path>
"""
import struct
import sys

LC_LOAD_DYLIB = 0xC
LC_SEGMENT_64 = 0x19
MH_MAGIC_64 = 0xFEEDFACF
FAT_MAGIC = 0xCAFEBABE


def add(data, base, library):
    magic, _, _, _, ncmds, sizeofcmds, _, _ = struct.unpack_from('<IiiIIIII', data, base)
    if magic != MH_MAGIC_64:
        raise SystemExit('Not a 64-bit Mach-O file.')
    offset, code = base + 32, len(data)
    for _ in range(ncmds):
        cmd, size = struct.unpack_from('<II', data, offset)
        if cmd == LC_LOAD_DYLIB:
            name = struct.unpack_from('<I', data, offset + 8)[0]
            if data[offset + name:offset + size].split(b'\0', 1)[0] == library:
                return
        if cmd == LC_SEGMENT_64:
            for s in range(struct.unpack_from('<I', data, offset + 64)[0]):
                start = struct.unpack_from('<I', data, offset + 72 + s * 80 + 48)[0]
                if start:
                    code = min(code, base + start)
        offset += size
    name = library + b'\0'
    size = (24 + len(name) + 7) // 8 * 8
    end = base + 32 + sizeofcmds
    if end + size > code or any(data[end:end + size]):
        raise SystemExit('No room for another load command.')
    data[end:end + size] = struct.pack('<IIIIII', LC_LOAD_DYLIB, size, 24, 2, 0x10000, 0x10000) + name.ljust(size - 24, b'\0')
    struct.pack_into('<II', data, base + 16, ncmds + 1, sizeofcmds + size)


def main():
    path, library = sys.argv[1], sys.argv[2].encode()
    with open(path, 'rb') as f:
        data = bytearray(f.read())
    if struct.unpack_from('>I', data, 0)[0] == FAT_MAGIC:
        for i in range(struct.unpack_from('>I', data, 4)[0]):
            add(data, struct.unpack_from('>I', data, 8 + i * 20 + 8)[0], library)
    else:
        add(data, 0, library)
    with open(path, 'wb') as f:
        f.write(data)


main()
