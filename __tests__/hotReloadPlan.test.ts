import { planHotReload, runLiveness } from "../src/hotReloadPlan.js";

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("runLiveness", () => {
  it("reports a process that answers signal 0 as alive", () => {
    expect(runLiveness(4242, () => {})).toBe("alive");
  });

  it("reports ESRCH as dead and EPERM (another user's process) as alive", () => {
    expect(runLiveness(4242, () => { throw errno("ESRCH"); })).toBe("dead");
    expect(runLiveness(4242, () => { throw errno("EPERM"); })).toBe("alive");
  });

  it("cannot judge a launch that recorded no pid", () => {
    expect(runLiveness(undefined, () => { throw errno("ESRCH"); })).toBe("unknown");
  });

  it("finds this test's own process alive with the real probe", () => {
    expect(runLiveness(process.pid)).toBe("alive");
  });
});

describe("planHotReload", () => {
  it("sends `r` over a control channel whose run is alive or unjudged", () => {
    for (const liveness of ["alive", "unknown"] as const) {
      expect(
        planHotReload({ hasControlChannel: true, liveness, reloadNeedsOwningRun: true })
      ).toEqual({ kind: "send-control" });
    }
  });

  it("refuses a physical Apple TV launch whose run has exited, naming the redeploy", () => {
    const plan = planHotReload({
      hasControlChannel: true,
      liveness: "dead",
      reloadNeedsOwningRun: true,
    });
    expect(plan.kind).toBe("refuse");
    expect(plan).toMatchObject({ fellBackFrom: "dead-control-channel" });
    expect((plan as { reason: string }).reason).toMatch(
      /run that owns this app is gone[\s\S]*no VM-service reload was attempted[\s\S]*Redeploy with flutter_deploy/
    );
  });

  it("refuses a physical Apple TV launch that recorded no control channel", () => {
    expect(
      planHotReload({ hasControlChannel: false, liveness: "alive", reloadNeedsOwningRun: true })
    ).toMatchObject({ kind: "refuse", fellBackFrom: "no-control-channel" });
  });

  it("falls back to the VM service where the device can compile, skipping a dead channel", () => {
    expect(
      planHotReload({ hasControlChannel: true, liveness: "dead", reloadNeedsOwningRun: false })
    ).toEqual({ kind: "vm-service", fellBackFrom: "dead-control-channel" });
    expect(
      planHotReload({ hasControlChannel: false, liveness: "unknown", reloadNeedsOwningRun: false })
    ).toEqual({ kind: "vm-service", fellBackFrom: "no-control-channel" });
  });
});
