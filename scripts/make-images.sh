#!/bin/sh
# Responsive WebP (+ one JPEG fallback) sets for thetatauzd.org. macOS: sips + cwebp (brew install webp).
#   sh scripts/make-images.sh SRC [OUT_DIR=Images/photos]
# SRC is a folder (every image in it) or one image file. The slug is the file name, lowercased and
# hyphenated, plus SUFFIX: stage a copy under the slug you want (home-hero.jpg -> home-hero-1280.webp).
# Knobs (environment variables):
#   WIDTHS="640 960 1280 1920 2560"  ascending ladder; widths above the source are skipped, and the
#                                    source width is added when it is >=10% past the last rung
#   JWIDTHS="1280" JPG=1             which rung(s) also get a JPEG (falls back to the largest rung)
#   CROP=W:H FOCUS=0..100            crop to that aspect first; FOCUS slides the window along the cut
#                                    axis (0 = left/top, 50 = centre, 100 = right/bottom)
#   SUFFIX=  (e.g. -portrait, -tile) SIZES=100vw  URL=/$OUT_DIR  QHI=80 (<=1080 px) QLO=70 (>1080 px) JQ=60
#   MAXKB="1080:120 1440:180"        size caps (page-weight budgets): a rung uses the cap of the smallest
#                                    listed width >= it; an over-cap WebP is re-encoded 5 quality steps lower until
#                                    it fits or reaches QMIN=40; then cwebp -size aims at the cap (a warning is
#                                    printed only if it still does not fit). Empty = no caps.
# Run it in a normal Terminal from the repo root: inside Claude's sandbox sips fails with "Error 13".
# Prints each file's size to stderr and a <source>/<img> snippet per image to stdout.
set -eu
SRC=${1:?usage: make-images.sh SRC [OUT_DIR]}; OUT=${2:-Images/photos}
WIDTHS=${WIDTHS:-"640 960 1280 1920 2560"}; JWIDTHS=${JWIDTHS:-"1280"}; JPG=${JPG:-1}
CROP=${CROP:-}; FOCUS=${FOCUS:-50}; SUFFIX=${SUFFIX:-}; SIZES=${SIZES:-100vw}; URL=${URL:-/$OUT}
QHI=${QHI:-80}; QLO=${QLO:-70}; JQ=${JQ:-60}; MAXKB=${MAXKB:-}; QMIN=${QMIN:-40}
SRGB="/System/Library/ColorSync/Profiles/sRGB Profile.icc"
command -v sips >/dev/null || { echo "sips missing: this script needs macOS" >&2; exit 1; }
command -v cwebp >/dev/null || { echo "cwebp missing: brew install webp" >&2; exit 1; }
case $FOCUS in ''|*[!0-9]*) echo "FOCUS must be 0..100" >&2; exit 1 ;; esac
[ "$FOCUS" -le 100 ] || { echo "FOCUS must be 0..100" >&2; exit 1; }
if [ -n "$CROP" ]; then case $CROP in *[!0-9:]*|:*|*:|*:*:*) echo "CROP must look like 3:2" >&2; exit 1 ;; *:*) ;; *) echo "CROP must look like 3:2" >&2; exit 1 ;; esac; fi
for pair in $MAXKB; do case $pair in *[!0-9:]*|:*|*:|*:*:*) echo "MAXKB must look like \"1080:120 1440:180\"" >&2; exit 1 ;; *:*) ;; *) echo "MAXKB must look like \"1080:120\"" >&2; exit 1 ;; esac; done
mkdir -p "$OUT"; TMP=$(mktemp -d "${TMPDIR:-/tmp}/mkimg.XXXXXX")
trap 'rm -rf "$TMP"' EXIT; trap 'exit 130' INT TERM
px() { sips -g "$1" "$2" | awk -v k="$1:" '$1 == k { print $2 }'; }
kb() { echo $(( ($(stat -f %z "$1") + 512) / 1024 )); }
has() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }
# cap RUNG: the KB cap for that rung (smallest MAXKB width >= RUNG), or nothing.
cap() { c=""; best=0
  for pair in $MAXKB; do pw=${pair%%:*}
    if [ "$pw" -ge "$1" ] && { [ "$best" -eq 0 ] || [ "$pw" -lt "$best" ]; }; then best=$pw; c=${pair#*:}; fi
  done; echo "$c"; }
if [ -d "$SRC" ]; then set -- "$SRC"/*; else set -- "$SRC"; fi
for f in "$@"; do
  [ -f "$f" ] || continue
  case $(printf %s "$f" | tr '[:upper:]' '[:lower:]') in *.jpg|*.jpeg|*.png|*.heic|*.tif|*.tiff|*.webp) ;; *) continue ;; esac
  base=$(basename "$f"); base=${base%.*}
  name=$(printf %s "$base" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//; s/-*$//')$SUFFIX
  # sRGB master as BMP: sips applies the EXIF rotation when it writes it, and BMP keeps no EXIF or GPS.
  sips -m "$SRGB" -s format bmp "$f" --out "$TMP/m.bmp" >/dev/null
  w=$(px pixelWidth "$TMP/m.bmp"); h=$(px pixelHeight "$TMP/m.bmp")
  if [ -n "$CROP" ]; then
    cw=${CROP%:*}; ch=${CROP#*:}
    if [ $(( w * ch )) -gt $(( h * cw )) ]; then nw=$(( h * cw / ch )); nh=$h; ox=$(( (w - nw) * FOCUS / 100 )); oy=0
    else nw=$w; nh=$(( w * ch / cw )); ox=0; oy=$(( (h - nh) * FOCUS / 100 )); fi
    # sips ignores the whole crop when offset + size lands exactly on the far edge, so stop one pixel short.
    if [ "$ox" -gt 0 ] && [ $(( ox + nw )) -ge "$w" ]; then ox=$(( w - nw - 1 )); fi
    if [ "$oy" -gt 0 ] && [ $(( oy + nh )) -ge "$h" ]; then oy=$(( h - nh - 1 )); fi
    sips -c "$nh" "$nw" --cropOffset "$oy" "$ox" "$TMP/m.bmp" --out "$TMP/c.bmp" >/dev/null
    mv "$TMP/c.bmp" "$TMP/m.bmp"
    [ "$(px pixelWidth "$TMP/m.bmp")x$(px pixelHeight "$TMP/m.bmp")" = "${nw}x${nh}" ] || { echo "$f: sips did not crop to ${nw}x${nh}" >&2; exit 1; }
    w=$nw; h=$nh
  fi
  list=""; last=0; max=0
  for r in $WIDTHS; do
    if [ "$r" -gt "$max" ]; then max=$r; fi
    if [ "$r" -le "$w" ]; then list="$list $r"; last=$r; fi
  done
  if [ "$w" -lt "$max" ] && [ $(( w * 10 )) -ge $(( last * 11 )) ]; then list="$list $w"; fi
  jlist=""; for r in $list; do if has "$r" "$JWIDTHS"; then jlist="$jlist $r"; fi; done
  [ -n "$jlist" ] || jlist=" $(echo $list | awk '{print $NF}')"
  if [ "$JPG" != 1 ]; then jlist=""; fi
  webp_set=""; jfb=""; tw=0; th=0
  for r in $list; do
    if [ "$r" -le 1080 ]; then q=$QHI; else q=$QLO; fi
    if [ "$r" -eq "$w" ]; then sips -s format png "$TMP/m.bmp" --out "$TMP/r.png" >/dev/null
    else sips --resampleWidth "$r" -s format png "$TMP/m.bmp" --out "$TMP/r.png" >/dev/null; fi
    rh=$(px pixelHeight "$TMP/r.png")
    lim=$(cap "$r")
    while :; do
      cwebp -quiet -q "$q" -m 6 -sharp_yuv -mt -metadata none "$TMP/r.png" -o "$OUT/$name-$r.webp"
      if [ -z "$lim" ] || [ "$(stat -f %z "$OUT/$name-$r.webp")" -le $(( lim * 1024 )) ]; then break; fi
      if [ "$q" -le "$QMIN" ]; then
        # Last resort: let cwebp search for the quality that hits the cap (multi-pass size target).
        cwebp -quiet -size $(( lim * 1000 )) -pass 6 -m 6 -sharp_yuv -mt -metadata none "$TMP/r.png" -o "$OUT/$name-$r.webp"; q=" set by -size"
        if [ "$(stat -f %z "$OUT/$name-$r.webp")" -gt $(( lim * 1024 )) ]; then echo "warning: $name-$r.webp is still over $lim KB" >&2; fi
        break
      fi
      q=$(( q - 5 )); if [ "$q" -lt "$QMIN" ]; then q=$QMIN; fi
    done
    msg="$(kb "$OUT/$name-$r.webp") KB webp q$q"; webp_set="$webp_set${webp_set:+, }$URL/$name-$r.webp ${r}w"
    if has "$r" "$jlist"; then
      sips -s format jpeg -s formatOptions "$JQ" "$TMP/r.png" --out "$OUT/$name-$r.jpg" >/dev/null
      msg="$msg, $(kb "$OUT/$name-$r.jpg") KB jpg"; jfb="$URL/$name-$r.jpg"
    fi
    printf '%-30s %5sx%-5s %s\n' "$name" "$r" "$rh" "$msg" >&2; tw=$r; th=$rh
  done
  printf '<!-- %s %sx%s -->\n<source type="image/webp" sizes="%s" srcset="%s">\n' "$name" "$tw" "$th" "$SIZES" "$webp_set"
  if [ -n "$jfb" ]; then printf '<img src="%s" width="%s" height="%s" alt="">\n' "$jfb" "$tw" "$th"; fi
done
