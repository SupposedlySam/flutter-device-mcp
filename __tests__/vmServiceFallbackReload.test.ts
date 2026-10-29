import { VmDriver } from "../src/hotReload.js";
import {
  CONTROL_CHANNEL_STATE,
  REDEPLOY_FOR_CONTROL_CHANNEL,
  vmServiceFallbackReload,
} from "../src/vmServiceFallbackReload.js";

const KERNEL_ERROR = "Error while starting Kernel isolate task";

class FakeDriver implements VmDriver {
  closed = false;
  constructor(
    private readonly isolates: string[],
    private readonly reloadSources: () => unknown
  ) {}
  async isolateIds(): Promise<string[]> {
    return this.isolates;
  }
  async call(method: string): Promise<unknown> {
    if (method === "reloadSources") return this.reloadSources();
    return undefined;
  }
  close(): void {
    this.closed = true;
  }
}

function request(
  connect: () => VmDriver,
  refusal?: () => Promise<string | undefined>
) {
  return {
    platform: "tvos",
    device: "atv-1",
    vmServiceUriWs: "ws://127.0.0.1:53182/abc=/ws",
    fellBackFrom: "dead-control-channel" as const,
    refusal,
    connect,
  };
}

describe("vmServiceFallbackReload", () => {
  it("refuses before connecting when the adapter says the device cannot reload", async () => {
    let connects = 0;
    const result = await vmServiceFallbackReload(
      request(
        () => {
          connects += 1;
          return new FakeDriver(["isolates/1"], () => ({ success: true }));
        },
        async () => "No kernel compiler on this box."
      )
    );

    expect(connects).toBe(0);
    expect(result.clearLaunch).toBe(false);
    expect(result.body).toMatchObject({ success: false, triggered: false });
    expect(result.body.reason).toBe(
      `${CONTROL_CHANNEL_STATE["dead-control-channel"]} No kernel compiler on this box. ` +
        REDEPLOY_FOR_CONTROL_CHANNEL
    );
  });

  it("reports nothing triggered when every isolate lacks a kernel compiler", async () => {
    const driver = new FakeDriver(["isolates/1", "isolates/2"], () => {
      throw new Error(KERNEL_ERROR);
    });
    const result = await vmServiceFallbackReload(request(() => driver));

    expect(result.body).toMatchObject({
      success: false,
      triggered: false,
      via: "vm-service",
      isolates: 2,
    });
    expect(result.body.reports).toEqual([
      { isolateId: "isolates/1", success: false, message: KERNEL_ERROR },
      { isolateId: "isolates/2", success: false, message: KERNEL_ERROR },
    ]);
    expect(result.body.reason).toMatch(/no kernel compiler/);
    expect(driver.closed).toBe(true);
  });

  it("reports a reload when the isolates accept it", async () => {
    const driver = new FakeDriver(["isolates/1"], () => ({
      type: "ReloadReport",
      success: true,
    }));
    const result = await vmServiceFallbackReload(request(() => driver, async () => undefined));

    expect(result.body).toMatchObject({
      success: true,
      triggered: true,
      via: "vm-service",
      fellBackFrom: "dead-control-channel",
      isolates: 1,
    });
    expect(result.clearLaunch).toBe(false);
  });

  it("asks for the launch record to be cleared when the VM service is unreachable", async () => {
    const driver = new FakeDriver([], () => undefined);
    driver.isolateIds = async () => {
      throw new Error("socket closed");
    };
    const result = await vmServiceFallbackReload(request(() => driver));

    expect(result.clearLaunch).toBe(true);
    expect(result.body).toMatchObject({ success: false, triggered: false });
    expect(result.body.reason).toMatch(/^socket closed .*redeploy with flutter_deploy/);
    expect(driver.closed).toBe(true);
  });
});
