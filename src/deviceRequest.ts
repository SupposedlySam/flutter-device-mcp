/**
 * The one rule every platform's device resolution follows: a device the caller
 * NAMED — a per-call `device_udid`, an env pin, a target file — is the device
 * the call acts on, or the call fails. It is never swapped for another one.
 *
 * Substitution used to be the documented behaviour ("a stale pin self-heals"),
 * and it was how a deploy aimed at a dead emulator installed a debug build onto
 * a developer's personal phone, uninstalling the Play Store copy of the app and
 * its data on the way. The warning it attached was accurate and read by nobody:
 * an unattended caller acts on the result, not on the prose beside it. Reads are
 * held to the same rule, because a screenshot or recording of the wrong device
 * reports someone else's screen as the requested one.
 *
 * With nothing named, a choice between several online targets is refused too:
 * "the first one listed" is how the phone beside an emulator gets picked.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/** A device the host can see right now, described for a refusal message. */
export interface OnlineDevice {
  id: string;
  /** e.g. "emulator, sdk_gphone64_arm64" or "physical, Pixel_7". */
  detail?: string;
}

function describeOnline(online: OnlineDevice[]): string {
  if (online.length === 0) return "none";
  return online
    .map((d) => (d.detail ? `${d.id} (${d.detail})` : d.id))
    .join(", ");
}

/**
 * Every refusal to pick a device. A caller that tolerates "no device attached"
 * must still let these through: each means the caller asked for something this
 * host cannot give without guessing.
 */
export class DeviceSelectionRefusedError extends McpError {
  constructor(message: string) {
    super(ErrorCode.InvalidParams, message);
    this.name = "DeviceSelectionRefusedError";
  }
}

/**
 * Thrown when a named device is not online. Carries the request so a host-side
 * caller that never touches the device (a scoped process teardown) can still act
 * on exactly the id that was named — as the platform lists it, when it does.
 */
export class RequestedDeviceUnavailableError extends DeviceSelectionRefusedError {
  readonly requested: string;
  readonly origin: string;
  /** The id the platform lists the named device under, when it is listed (offline). */
  readonly listedAs?: string;

  constructor(opts: {
    platform: string;
    requested: string;
    /** Where the name came from, e.g. "the device_udid argument". */
    origin: string;
    /** The platform's own state for the device when it is listed, e.g. "unauthorized". */
    state?: string;
    listedAs?: string;
    online: OnlineDevice[];
    hint?: string;
  }) {
    const stateNote = opts.state ? ` (it is listed, in state "${opts.state}")` : "";
    super(
      `The requested ${opts.platform} device "${opts.requested}" (from ${opts.origin}) ` +
        `is not online${stateNote}. Online ${opts.platform} devices: ` +
        `${describeOnline(opts.online)}. Nothing was done: a named device is never ` +
        `replaced by a different one. Bring "${opts.requested}" back online, or name ` +
        `one of the online devices explicitly.` +
        (opts.hint ? ` ${opts.hint}` : "")
    );
    this.name = "RequestedDeviceUnavailableError";
    this.requested = opts.requested;
    this.origin = opts.origin;
    this.listedAs = opts.listedAs;
  }
}

/**
 * Thrown when the class of target asked for (emulator/simulator vs physical)
 * does not match what the name resolves to, or no online target of that class
 * exists. An emulator request must never be served by a physical device.
 */
export function targetClassUnavailable(opts: {
  platform: string;
  wanted: string;
  requested?: string;
  resolvedClass?: string;
  online: OnlineDevice[];
}): DeviceSelectionRefusedError {
  const article = /^[aeiou]/i.test(opts.wanted) ? "an" : "a";
  const subject = opts.requested
    ? `"${opts.requested}" is a ${opts.resolvedClass} target, but ${article} ${opts.wanted} was requested`
    : `${article} ${opts.wanted} was requested and none is online`;
  return new DeviceSelectionRefusedError(
    `No ${opts.platform} ${opts.wanted} to use: ${subject}. Online ${opts.platform} ` +
      `devices: ${describeOnline(opts.online)}. Nothing was done: ${article} ${opts.wanted} ` +
      `request is never served by a different class of device.`
  );
}

/** Thrown when nothing was named and more than one target could be meant. */
export function unnamedChoiceRefused(opts: {
  platform: string;
  online: OnlineDevice[];
  hint: string;
}): DeviceSelectionRefusedError {
  return new DeviceSelectionRefusedError(
    `${opts.online.length} ${opts.platform} devices are online and none was named: ` +
      `${describeOnline(opts.online)}. Nothing was done: with more than one online, ` +
      `picking one would be a guess. ${opts.hint}`
  );
}

/** Thrown when a name (a model or device name) matches more than one online target. */
export function ambiguousNameRefused(opts: {
  platform: string;
  requested: string;
  origin: string;
  matches: OnlineDevice[];
}): DeviceSelectionRefusedError {
  return new DeviceSelectionRefusedError(
    `The requested ${opts.platform} device "${opts.requested}" (from ${opts.origin}) ` +
      `matches ${opts.matches.length} online ${opts.platform} devices: ` +
      `${describeOnline(opts.matches)}. Nothing was done. Name one of them by its id.`
  );
}

/**
 * Thrown when a per-call `device_udid` names a device this platform's call would
 * not act on, or when the platform cannot take one at all (webOS).
 */
export function callPinNotHonoured(message: string): DeviceSelectionRefusedError {
  return new DeviceSelectionRefusedError(`${message} Nothing was done.`);
}

/**
 * Choose among the devices a name matched: exactly one online match is the
 * device; several online is ambiguous; none online is "not online".
 */
export function pickNamedMatch<T>(
  matches: T[],
  isOnline: (d: T) => boolean
): { kind: "one"; device: T } | { kind: "several"; devices: T[] } | { kind: "none"; listed?: T } {
  const online = matches.filter(isOnline);
  if (online.length === 1) return { kind: "one", device: online[0] };
  if (online.length > 1) return { kind: "several", devices: online };
  return { kind: "none", listed: matches[0] };
}
