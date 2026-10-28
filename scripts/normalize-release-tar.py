#!/usr/bin/env python3
"""Write the release TAR with reproducible timestamps and gzip metadata."""

import gzip
import os
from pathlib import Path, PurePosixPath
import tarfile


source = Path(os.environ["PETUJA_RELEASE_TAR"])
epoch = int(os.environ["PETUJA_RELEASE_EPOCH"])
if source.suffix != ".tar" or source.is_symlink() or not source.is_file() or not 315532800 <= epoch <= 4354819198:
    raise SystemExit("Invalid release TAR or source timestamp")
destination = Path(str(source) + ".gz")
names = set()

with tarfile.open(source, "r:") as existing, destination.open("xb") as raw:
    with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as output:
            for member in existing:
                name = PurePosixPath(member.name)
                if (name.is_absolute() or ".." in name.parts or str(name) in names
                        or not (member.isfile() or member.isdir())):
                    raise ValueError("Unsupported release TAR member: " + member.name)
                names.add(str(name))
                member.mtime = epoch
                member.pax_headers.pop("mtime", None)
                if member.isfile():
                    with existing.extractfile(member) as content:
                        output.addfile(member, content)
                else:
                    output.addfile(member)
