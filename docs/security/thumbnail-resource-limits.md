# Thumbnail and orientation resource limits

The authenticated raw thumbnail endpoint and optional JPEG EXIF rotation process
sender-controlled image bytes. Authentication does not establish image safety.

These transformations now require PHP GD. They materialize at most 8 MiB plus
one overflow-detection byte from the MIME-transfer-decoded stream. The compressed
raster itself must fit within 8 MiB. Native header metadata must identify GIF,
JPEG, PNG or WebP, with positive dimensions, neither edge above 8192 pixels,
and at most 8,000,000 pixels. Pixel checks use division before multiplication.
The decoder must still accept the image; header inspection is not validation of
the complete format. Actual decoded GD geometry is checked again before transforms.
Both public GD factory methods share the source/geometry checks.

GD supplies a single raster rather than a decoded image sequence. GIF uses the
first frame; an unsupported animated encoding may fail in the native decoder.
Thumbnail output remains a centered 48x48 PNG. Center-cropping the source before
resampling prevents narrow images from amplifying the resize intermediate.
Only bounded source/crop/output surfaces are requested by application transforms.

Imagick and Gmagick adapters remain as upstream library code, but no application
image transformation dispatches to them. Their supported versions do not provide
a demonstrated common pre-decode frame/resource bound here. There is deliberately
no guessed fallback. Servers with only those extensions must install/enable GD
to regain thumbnails and EXIF rotation. The public thumbnail capability requires
GD; administrative configuration visibility remains unchanged. This protection
does not claim to constrain unrelated external code calling dormant adapters.

Images exceeding these limits, unsupported formats and unavailable GD fail
through the existing controlled transformation error path. Some camera photos
above 8 MP will have no generated preview. Ordinary downloads, untransformed
views and the existing file-hash pass-through retain their original bytes and
headers. To retrieve a rejected original, use the download path. No dependency
version, UI, mailbox authorization, MIME decoding or IMAP parser was changed.

The cap bounds application materialization and decoder input, not the complete
IMAP network transfer: the parser may drain the remaining literal to preserve
protocol synchronization. PHP stream filters/wrappers may prefetch a bounded
chunk beyond the materialized limit. The tests account for this separately.

These are practical application work limits, not a universal process-memory or
CPU guarantee. Two 8 MP RGBA surfaces take roughly 64 MB before codec overhead;
source, EXIF handling and ordinary application state also consume memory.
Operators still need adequate worker memory, current native GD/codecs and normal
worker/request controls. No hostile host/filesystem or native decoder bug model
is claimed. Generated small images and decoder counters validate rejected headers;
tests never decode extreme geometry or attempt worker exhaustion.
