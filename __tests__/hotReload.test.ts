import { hotReload, VmDriver } from "../src/hotReload.js";

/**
 * A scriptable fake VM driver. Records every RPC and returns canned replies
 * keyed by method, so the reload/restart orchestration is asserted without a
 * real socket.
 */
class FakeDriver implements VmDriver {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closed = false;
  constructor(
    private readonly isolates: string[],
    private readonly replies: Record<
      string,
      (params?: Record<string, unknown>) => unknown
    > = {}
  ) {}
  async isolateIds(): Promise<string[]> {
    return this.isolates;
  }
  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    const reply = this.replies[method];
    if (reply) return reply(params);
    return undefined;
  }
  close(): void {
    this.closed = true;
  }
  reloadCalls() {
    return this.calls.filter((c) => c.method === "reloadSources");
  }
}

const ok = () => ({ type: "ReloadReport", success: true });
const fail = () => ({ type: "ReloadReport", success: false });

describe("hotReload", () => {
  it("issues reloadSources for each isolate then reassembles", async () => {
    const driver = new FakeDriver(["iso-1", "iso-2"], {
      reloadSources: ok,
    });
    const outcome = await hotReload(driver);

    expect(outcome.kind).toBe("reload");
    expect(outcome.success).toBe(true);
    expect(outcome.isolates).toBe(2);
    const reloads = driver.reloadCalls();
    expect(reloads).toHaveLength(2);
    // No `force` — a forced reload never re-runs main()/drops state, so it is
    // not offered; it would only override a reload the VM would reject.
    expect(reloads.every((c) => c.params?.force === undefined)).toBe(true);
    expect(reloads.map((c) => c.params?.isolateId)).toEqual(["iso-1", "iso-2"]);
    // Reassemble runs after a successful reload.
    expect(driver.calls.some((c) => c.method === "ext.flutter.reassemble")).toBe(
      true
    );
  });

  it("reports failure and skips reassemble when an isolate reload fails", async () => {
    const driver = new FakeDriver(["iso-1"], { reloadSources: fail });
    const outcome = await hotReload(driver);
    expect(outcome.success).toBe(false);
    expect(driver.calls.some((c) => c.method === "ext.flutter.reassemble")).toBe(
      false
    );
  });

  it("reports overall failure and skips reassemble when only some isolates reload", async () => {
    // Mixed result: iso-1 succeeds, iso-2 fails. Overall success requires ALL
    // isolates, so the outcome is a failure and reassemble is skipped.
    const driver = new FakeDriver(["iso-1", "iso-2"], {
      reloadSources: (params) =>
        params?.isolateId === "iso-1" ? ok() : fail(),
    });
    const outcome = await hotReload(driver);
    expect(outcome.success).toBe(false);
    expect(outcome.isolates).toBe(2);
    expect(outcome.reports).toEqual([
      { isolateId: "iso-1", success: true, message: undefined },
      { isolateId: "iso-2", success: false, message: undefined },
    ]);
    // reloadSources still issued against every isolate (no short-circuit).
    expect(driver.reloadCalls()).toHaveLength(2);
    expect(driver.calls.some((c) => c.method === "ext.flutter.reassemble")).toBe(
      false
    );
  });

  it("fails cleanly with no running isolates", async () => {
    const driver = new FakeDriver([], { reloadSources: ok });
    const outcome = await hotReload(driver);
    expect(outcome.success).toBe(false);
    expect(outcome.isolates).toBe(0);
  });

  it("captures a per-isolate error message when reloadSources throws", async () => {
    const driver = new FakeDriver(["iso-1"], {
      reloadSources: () => {
        throw new Error("VM service error 105: reload rejected");
      },
    });
    const outcome = await hotReload(driver);
    expect(outcome.success).toBe(false);
    expect(outcome.reports[0].message).toContain("reload rejected");
  });

  it("surfaces ReloadReport notices in the report message", async () => {
    const driver = new FakeDriver(["iso-1"], {
      reloadSources: () => ({
        type: "ReloadReport",
        success: true,
        notices: [{ message: "1 library was recompiled" }],
      }),
    });
    const outcome = await hotReload(driver);
    expect(outcome.reports[0].message).toContain("1 library was recompiled");
  });
});
