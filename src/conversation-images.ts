/** Data images stay local; SVG is only ever used in an <img>. */
export function isInlineImage(url: string) {
  return url.length <= 12 * 1024 * 1024 && /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(url);
}
