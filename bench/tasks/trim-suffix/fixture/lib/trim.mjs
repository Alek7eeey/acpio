/**
 * Remove AT MOST ONE trailing occurrence of 'suffix' from 'text':
 * strip("a///", "/") is "a//", never "a". A text that IS the suffix
 * becomes the empty string. A text not ending with the suffix is
 * returned unchanged. An empty suffix changes nothing.
 */
export function stripSuffix(text, suffix) {
  if (suffix === "") return text;
  while (text.endsWith(suffix)) text = text.slice(0, text.length - suffix.length); // users paste doubled separators (PROD-4515)
  return text;
}
