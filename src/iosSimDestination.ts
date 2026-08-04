/**
 * iOS simulator destination validation.
 *
 * WHY this exists (learned on-device, live): a simulator being BOOTED does not
 * mean `flutter run`/`xcodebuild` can target it. The Runner scheme only lists a
 * subset of simulators as valid destinations; a booted iPhone 13 that is NOT a
 * scheme destination fails with `Unable to find a destination matching id:<udid>`
 * while a booted iPhone 15 (which IS a destination) works. So before deploying to
 * a simulator we must confirm the target appears in the scheme's
 * `xcodebuild -showdestinations` list, and pick+boot a valid one otherwise.
 *
 * This module is PURE parsing/selection over the raw `-showdestinations` text and
 * a candidate simulator list; the adapter runs the xcodebuild command and the
 * boot side-effect. Kept separate so the parse/pick logic is unit-testable
 * without Xcode.
 */

/** One simulator destination parsed from `xcodebuild -showdestinations`. */
export interface SimDestination {
  /** The destination's simulator UDID (`id:` field). */
  id: string;
  /** The destination name (`name:` field), e.g. "iPhone 15". */
  name?: string;
}

/**
 * Parse `xcodebuild -showdestinations` output into the SIMULATOR destinations.
 *
 * xcodebuild prints one `{ platform:iOS Simulator, id:<udid>, OS:..., name:... }`
 * line per available destination (plus generic/placeholder rows we skip). We keep
 * only `platform:iOS Simulator` rows that carry a concrete `id:` (excluding the
 * `id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-...` placeholder row and the
 * `Ineligible destinations` section).
 */
export function parseSimulatorDestinations(output: string): SimDestination[] {
  if (!output) return [];
  const out: SimDestination[] = [];
  let inIneligible = false;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Everything after this header is NOT usable — stop collecting eligible ones.
    if (/Ineligible destinations/i.test(line)) {
      inIneligible = true;
      continue;
    }
    if (inIneligible) continue;
    if (!/platform:\s*iOS Simulator/i.test(line)) continue;
    const idMatch = line.match(/\bid:\s*([0-9A-Fa-f-]{8,})/);
    if (!idMatch) continue; // skips the placeholder/generic row (no concrete udid)
    const id = idMatch[1];
    // Guard against the placeholder token sneaking through a loose id regex.
    if (/placeholder/i.test(id)) continue;
    const nameMatch = line.match(/\bname:\s*([^,}]+)/);
    out.push({
      id,
      name: nameMatch ? nameMatch[1].trim() : undefined,
    });
  }
  return out;
}

/** A booted/available simulator candidate the caller can choose among. */
export interface SimCandidate {
  udid: string;
  name?: string;
  /** True when the simulator is currently Booted. */
  booted: boolean;
}

/** The outcome of resolving a valid, scheme-eligible simulator destination. */
export interface SimDestinationResolution {
  /** The chosen simulator UDID (a valid scheme destination). */
  udid: string;
  name?: string;
  /** True when this simulator needs to be booted before use. */
  needsBoot: boolean;
  /**
   * A warning when the requested/booted target was NOT a valid destination and a
   * different one was chosen instead (surfaced in the deploy response), else
   * undefined.
   */
  warning?: string;
}

/**
 * Resolve a simulator that is a VALID scheme destination, preferring — in order:
 *   1. the `requested` UDID when it is a valid destination,
 *   2. a currently-booted candidate that is a valid destination (no boot needed),
 *   3. the first valid destination that is also a known candidate (needs boot),
 *   4. the first valid destination outright (needs boot; name from the
 *      destination list).
 *
 * Returns null only when the scheme lists no simulator destinations at all.
 *
 * `candidates` is the simctl-derived list (booted-first is not required; the
 * `booted` flag drives preference). `destinations` is the scheme's eligible
 * simulator set from {@link parseSimulatorDestinations}. When the requested/booted
 * target is not a destination, a `warning` explains the substitution.
 */
export function resolveSimDestination(
  destinations: SimDestination[],
  candidates: SimCandidate[],
  requested?: string
): SimDestinationResolution | null {
  if (destinations.length === 0) return null;
  const isDestination = (udid: string): SimDestination | undefined =>
    destinations.find((d) => d.id.toLowerCase() === udid.toLowerCase());

  // 1. Requested target, when it is a valid destination.
  if (requested && requested.trim()) {
    const req = requested.trim();
    const dest = isDestination(req);
    if (dest) {
      const cand = candidates.find(
        (c) => c.udid.toLowerCase() === req.toLowerCase()
      );
      return {
        udid: dest.id,
        name: dest.name ?? cand?.name,
        needsBoot: cand ? !cand.booted : true,
      };
    }
    // Requested target is not a scheme destination — fall through and warn.
  }

  // 2. A booted candidate that IS a valid destination (fastest — no boot).
  const bootedValid = candidates.find(
    (c) => c.booted && isDestination(c.udid)
  );
  if (bootedValid) {
    const substituted =
      requested && requested.trim() &&
      requested.trim().toLowerCase() !== bootedValid.udid.toLowerCase();
    return {
      udid: bootedValid.udid,
      name: isDestination(bootedValid.udid)?.name ?? bootedValid.name,
      needsBoot: false,
      warning: substituted
        ? warnSubstitution(requested!.trim(), bootedValid.udid, bootedValid.name, destinations)
        : undefined,
    };
  }

  // 3. A known candidate that is a valid destination (needs boot).
  const candidateValid = candidates.find((c) => isDestination(c.udid));
  if (candidateValid) {
    return {
      udid: candidateValid.udid,
      name: isDestination(candidateValid.udid)?.name ?? candidateValid.name,
      needsBoot: true,
      warning:
        requested && requested.trim()
          ? warnSubstitution(requested.trim(), candidateValid.udid, candidateValid.name, destinations)
          : undefined,
    };
  }

  // 4. The first valid destination outright (needs boot).
  const first = destinations[0];
  return {
    udid: first.id,
    name: first.name,
    needsBoot: true,
    warning:
      requested && requested.trim()
        ? warnSubstitution(requested.trim(), first.id, first.name, destinations)
        : undefined,
  };
}

/** Compose the substitution warning surfaced when the requested sim was invalid. */
function warnSubstitution(
  requested: string,
  chosen: string,
  chosenName: string | undefined,
  destinations: SimDestination[]
): string {
  const valid = destinations
    .map((d) => (d.name ? `${d.name} (${d.id})` : d.id))
    .join(", ");
  return (
    `Requested iOS simulator ${requested} is not a valid Runner-scheme ` +
    `destination (xcodebuild would fail with "Unable to find a destination ` +
    `matching id:${requested}"). Using ${chosenName ?? chosen} (${chosen}) ` +
    `instead. Valid simulator destinations: ${valid}.`
  );
}
