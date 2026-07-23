import os from "os";
import {
  androidRemoteRecordingPath,
  ANDROID_MAX_DURATION_SECONDS,
  buildAdbPullCommand,
  buildAdbRemoveCommand,
  buildAdbScreenrecordCommand,
  buildAdbStopScreenrecordCommand,
  buildFfmpegFramesToGifCommands,
  buildFfmpegFramesToVideoCommand,
  buildFfmpegVideoToGifCommands,
  buildPymobiledevice3BurstFrameCommand,
  buildSimctlRecordVideoCommand,
  burstFrameName,
  defaultRecordingPath,
} from "../src/recording.js";

describe("buildAdbScreenrecordCommand", () => {
  it("builds a plain `adb shell screenrecord <remote>` with no flags", () => {
    expect(
      buildAdbScreenrecordCommand("emulator-5554", "/sdcard/out.mp4")
    ).toBe("adb -s 'emulator-5554' shell screenrecord '/sdcard/out.mp4'");
  });

  it("adds --time-limit / --size / --bit-rate when supplied", () => {
    const cmd = buildAdbScreenrecordCommand("dev1", "/sdcard/o.mp4", {
      timeLimitSeconds: 12,
      size: "1280x720",
      bitRate: 8000000,
    });
    expect(cmd).toContain("--time-limit 12");
    expect(cmd).toContain("--size '1280x720'");
    expect(cmd).toContain("--bit-rate 8000000");
  });

  it("clamps --time-limit to the 180s screenrecord ceiling", () => {
    const cmd = buildAdbScreenrecordCommand("dev1", "/sdcard/o.mp4", {
      timeLimitSeconds: 999,
    });
    expect(cmd).toContain(`--time-limit ${ANDROID_MAX_DURATION_SECONDS}`);
  });
});

describe("buildAdbStopScreenrecordCommand", () => {
  it("SIGINTs the ON-DEVICE screenrecord so the mp4 flushes (not a host kill)", () => {
    expect(buildAdbStopScreenrecordCommand("dev1")).toBe(
      "adb -s 'dev1' shell pkill -INT screenrecord"
    );
  });
});

describe("buildAdbPullCommand / buildAdbRemoveCommand", () => {
  it("pulls the remote clip to a quoted local path", () => {
    expect(
      buildAdbPullCommand("dev1", "/sdcard/o.mp4", "/tmp/local out.mp4")
    ).toBe("adb -s 'dev1' pull '/sdcard/o.mp4' '/tmp/local out.mp4'");
  });

  it("removes the remote clip with rm -f", () => {
    expect(buildAdbRemoveCommand("dev1", "/sdcard/o.mp4")).toBe(
      "adb -s 'dev1' shell rm -f '/sdcard/o.mp4'"
    );
  });
});

describe("buildSimctlRecordVideoCommand", () => {
  it("uses --codec=h264 and --force and quotes the udid + path", () => {
    expect(buildSimctlRecordVideoCommand("AAAA-1111", "/tmp/o.mp4")).toBe(
      "xcrun simctl io 'AAAA-1111' recordVideo --codec=h264 --force '/tmp/o.mp4'"
    );
  });
});

describe("buildPymobiledevice3BurstFrameCommand", () => {
  it("builds one dvt screenshot frame, appending --udid when given", () => {
    expect(
      buildPymobiledevice3BurstFrameCommand(
        "pymobiledevice3",
        "/tmp/frames/frame_0003.png",
        "ECID-1"
      )
    ).toBe(
      "'pymobiledevice3' developer dvt screenshot '/tmp/frames/frame_0003.png' --udid 'ECID-1'"
    );
  });

  it("omits --udid when no udid is given", () => {
    expect(
      buildPymobiledevice3BurstFrameCommand("pymobiledevice3", "/tmp/f.png")
    ).not.toContain("--udid");
  });
});

describe("burstFrameName", () => {
  it("zero-pads to the %04d pattern ffmpeg expects", () => {
    expect(burstFrameName(0)).toBe("frame_0000.png");
    expect(burstFrameName(42)).toBe("frame_0042.png");
    expect(burstFrameName(1234)).toBe("frame_1234.png");
  });
});

describe("buildFfmpegFramesToVideoCommand", () => {
  it("assembles frames at the given fps with an even-dimension scale + yuv420p", () => {
    const cmd = buildFfmpegFramesToVideoCommand(
      "/opt/homebrew/bin/ffmpeg",
      "/tmp/frames",
      3,
      "/tmp/out.mp4"
    );
    expect(cmd).toContain("'/opt/homebrew/bin/ffmpeg' -y -framerate 3");
    expect(cmd).toContain("/tmp/frames/frame_%04d.png");
    expect(cmd).toContain("trunc(iw/2)*2:trunc(ih/2)*2");
    expect(cmd).toContain("-pix_fmt yuv420p");
    expect(cmd.endsWith("'/tmp/out.mp4'")).toBe(true);
  });
});

describe("buildFfmpegFramesToGifCommands (two-pass palette)", () => {
  it("returns [palettegen, paletteuse] over the frame pattern", () => {
    const [gen, use] = buildFfmpegFramesToGifCommands(
      "ffmpeg",
      "/tmp/frames",
      2,
      "/tmp/out.gif",
      "/tmp/palette.png"
    );
    expect(gen).toContain("palettegen");
    expect(gen).toContain("/tmp/frames/frame_%04d.png");
    expect(gen.endsWith("'/tmp/palette.png'")).toBe(true);
    expect(use).toContain("paletteuse");
    expect(use).toContain("'/tmp/palette.png'");
    expect(use.endsWith("'/tmp/out.gif'")).toBe(true);
  });
});

describe("buildFfmpegVideoToGifCommands (mp4 -> gif, two-pass palette)", () => {
  it("downsamples to the target fps and applies a generated palette", () => {
    const [gen, use] = buildFfmpegVideoToGifCommands(
      "ffmpeg",
      "/tmp/in.mp4",
      5,
      "/tmp/out.gif",
      "/tmp/palette.png"
    );
    expect(gen).toContain("-i '/tmp/in.mp4'");
    expect(gen).toContain("fps=5,palettegen");
    expect(use).toContain("fps=5[x];[x][1:v]paletteuse");
    expect(use.endsWith("'/tmp/out.gif'")).toBe(true);
  });
});

describe("defaultRecordingPath", () => {
  it("produces a unique path under tmp tagged by platform + format", () => {
    const mp4 = defaultRecordingPath("android", "mp4");
    expect(mp4.startsWith(os.tmpdir())).toBe(true);
    expect(mp4).toContain("flutter-device-mcp-recording-android-");
    expect(mp4.endsWith(".mp4")).toBe(true);

    const gif = defaultRecordingPath("ios", "gif");
    expect(gif.endsWith(".gif")).toBe(true);
  });
});

describe("androidRemoteRecordingPath", () => {
  it("targets world-writable /sdcard with an .mp4 name", () => {
    const p = androidRemoteRecordingPath();
    expect(p.startsWith("/sdcard/")).toBe(true);
    expect(p.endsWith(".mp4")).toBe(true);
  });
});
