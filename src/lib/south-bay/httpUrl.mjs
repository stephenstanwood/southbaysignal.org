/**
 * Normalize an absolute HTTP(S) URL, rejecting malformed concatenated origins.
 *
 * `new URL()` alone accepts strings such as
 * `https://volunteer.openspace.orghttps//s3.amazonaws.com/image.jpg` by
 * interpreting `volunteer.openspace.orghttps` as the hostname. Those values
 * look absolute to downstream schema/render code but are not fetchable URLs.
 */
export function normalizeAbsoluteHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname || /https?$/i.test(url.hostname) || url.pathname.startsWith("//")) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Same, but for URLs the browser loads as a subresource (event artwork).
 *
 * southbaytoday.org is HTTPS-only, so an `http://` image is blocked as mixed
 * content and the card renders with a hole in it. Every host we've seen serve
 * one (static1.squarespace.com, via feeds that still emit the legacy scheme)
 * answers the identical URL over HTTPS, so upgrade rather than drop.
 */
export function normalizeImageUrl(value) {
  const url = normalizeAbsoluteHttpUrl(value);
  if (!url) return null;
  return url.startsWith("http://") ? `https://${url.slice("http://".length)}` : url;
}
