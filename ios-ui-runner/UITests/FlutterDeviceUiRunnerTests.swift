import XCTest

/// Runs FLUTTER_DEVICE_UI_STEPS, a comma-separated script: up<N>, down<N>, wait<S>, tap@<x>:<y>.
/// A tap is in points from the top-left of the target app's window, the space
/// Flutter calls logical pixels.
final class FlutterDeviceUiRunnerTests: XCTestCase {
  private let volumePressInterval: useconds_t = 250_000

  func testRunSteps() throws {
    let env = ProcessInfo.processInfo.environment
    guard let bundleId = env["FLUTTER_DEVICE_UI_TARGET"], !bundleId.isEmpty else {
      XCTFail("FLUTTER_DEVICE_UI_TARGET names no app to drive")
      return
    }
    let target = XCUIApplication(bundleIdentifier: bundleId)
    // The runner otherwise leaves its own blank host app in front.
    target.activate()
    sleep(2)
    for step in StepParser.split(env["FLUTTER_DEVICE_UI_STEPS"] ?? "") {
      try run(step, on: target)
    }
  }

  private func run(_ step: String, on target: XCUIApplication) throws {
    if let (button, count) = StepParser.volume(step) {
      for _ in 0..<count {
        XCUIDevice.shared.press(button)
        usleep(volumePressInterval)
      }
    } else if let seconds = StepParser.wait(step) {
      sleep(seconds)
    } else if let point = StepParser.tap(step) {
      target.coordinate(withNormalizedOffset: .zero)
        .withOffset(CGVector(dx: point.x, dy: point.y)).tap()
    } else {
      XCTFail("Unknown step '\(step)'")
    }
  }
}

enum StepParser {
  static func split(_ script: String) -> [String] {
    script.split(separator: ",", omittingEmptySubsequences: true).map(String.init)
  }

  static func volume(_ step: String) -> (XCUIDevice.Button, Int)? {
    for (prefix, button) in [("up", XCUIDevice.Button.volumeUp), ("down", .volumeDown)]
    where step.hasPrefix(prefix) {
      if let count = Int(step.dropFirst(prefix.count)) { return (button, count) }
    }
    return nil
  }

  static func wait(_ step: String) -> UInt32? {
    step.hasPrefix("wait") ? UInt32(step.dropFirst(4)) : nil
  }

  static func tap(_ step: String) -> CGPoint? {
    guard step.hasPrefix("tap@") else { return nil }
    let parts = step.dropFirst(4).split(separator: ":").compactMap { Double($0) }
    return parts.count == 2 ? CGPoint(x: parts[0], y: parts[1]) : nil
  }
}
