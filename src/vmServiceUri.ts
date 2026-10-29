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

// flutter's own announcement of the URI to connect to. The host is whatever
// flutter made reachable: loopback when DDS fronts the service, or the device's
// LAN address, Bonjour name or bracketed IPv6 when it does not. 0.0.0.0 is the
// device-side bind address and is never connectable from the Mac.
const ANNOUNCED_VM_SERVICE_PATTERN =
  /A Dart VM Service on .+? is available at: (https?:\/\/(?!0\.0\.0\.0[:/])(?:\[[0-9A-Fa-f:.%]+\]|[A-Za-z0-9.-]+):\d+\/[A-Za-z0-9_=-]*\/?)/g;

/**
 * Extract the VM Service URI from the line flutter announces it on, and from
 * nothing else.
 *
 * A device runner that echoes the app's console also echoes the VM's own
 * "listening on http://127.0.0.1:PORT/" line, and that port is on the device,
 * not the Mac. {@link parseVmServiceUri} would take it; this does not, because
 * only the announcement carries an address flutter has made reachable. The last
 * announcement wins, as it does there.
 */
export function parseAnnouncedVmServiceUri(text: string): VmServiceUri | null {
  if (!text) return null;
  let raw: string | undefined;
  for (const match of text.matchAll(ANNOUNCED_VM_SERVICE_PATTERN)) {
    raw = match[1];
  }
  if (!raw) return null;
  const http = raw.endsWith("/") ? raw : `${raw}/`;
  return { http, ws: `${http.replace(/^http/, "ws")}ws` };
}
