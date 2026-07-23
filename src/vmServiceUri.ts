/**
 * Extraction of the Dart VM Service URI from flutter launch output.
 *
 * flutter-tizen (and other flutter runners) print a line such as:
 *   "A Dart VM Service on ... is available at: http://127.0.0.1:51182/tys47XX1iAw=/"
 * The Marionette tooling connects over the WebSocket form of that URI
 * (`ws://.../ws`). This module turns the raw log text into both forms. It is
 * platform-neutral: any flutter runner that prints a loopback VM Service URI
 * parses the same way.
 */

export interface VmServiceUri {
  /** The HTTP form as printed, always ending in a single trailing slash. */
  http: string;
  /** The WebSocket form used by Marionette, ending in `/ws`. */
  ws: string;
}

// A loopback VM Service URI: http(s)://127.0.0.1:PORT/TOKEN/ where TOKEN is the
// base64url-ish auth code flutter emits (may include `=`, `_`, `-`). The token
// segment and the trailing slash are both optional in the raw text.
const VM_SERVICE_URI_PATTERN =
  /https?:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_=-]*\/?/g;

/**
 * Extract the last VM Service URI from arbitrary log text and derive its ws
 * form. flutter can emit an early URI and then a corrected one, so the LAST
 * match wins. Returns null when no loopback VM Service URI is present.
 */
export function parseVmServiceUri(text: string): VmServiceUri | null {
  if (!text) return null;

  const matches = text.match(VM_SERVICE_URI_PATTERN);
  if (!matches || matches.length === 0) return null;

  const raw = matches[matches.length - 1];

  // Normalize to exactly one trailing slash for the http form.
  const http = raw.endsWith("/") ? raw : `${raw}/`;

  // The ws form swaps the scheme and appends the `ws` endpoint.
  const ws = `${http.replace(/^http/, "ws")}ws`;

  return { http, ws };
}
