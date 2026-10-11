import { describe, expect, it } from "vitest";
import { buildSafeMissAvNavigationTarget } from "../../../../services/downloaders/missav/navigation";

describe("buildSafeMissAvNavigationTarget", () => {
  it("accepts mirror prefix with language segment", () => {
    const result = buildSafeMissAvNavigationTarget(
      "https://missav.ai/dm2/cn/jufe-279-uncensored-leak",
    );

    expect(result.origin).toBe("https://missav.ai");
    expect(result.path).toBe("/dm2/cn/jufe-279-uncensored-leak");
    expect(result.url).toBe(
      "https://missav.ai/dm2/cn/jufe-279-uncensored-leak",
    );
  });

  it("accepts larger mirror prefix numbers", () => {
    const result = buildSafeMissAvNavigationTarget(
      "https://missav.ai/dm78/cn/hnd-966-uncensored-leak",
    );

    expect(result.path).toBe("/dm78/cn/hnd-966-uncensored-leak");
  });

  it("accepts a bare language path", () => {
    const result = buildSafeMissAvNavigationTarget(
      "https://missav.ai/cn/luxu-381-uncensored-leak",
    );

    expect(result.path).toBe("/cn/luxu-381-uncensored-leak");
  });

  it("accepts previously whitelisted language paths", () => {
    const result = buildSafeMissAvNavigationTarget(
      "https://missav.ai/en/some-video-id",
    );

    expect(result.path).toBe("/en/some-video-id");
  });

  it("accepts a plain video path", () => {
    const result = buildSafeMissAvNavigationTarget(
      "https://missav.ai/some-video-id",
    );

    expect(result.path).toBe("/some-video-id");
  });

  it("rejects non-missav hosts", () => {
    expect(() =>
      buildSafeMissAvNavigationTarget("https://evil.example.com/dm2/cn/video"),
    ).toThrow(/Hostname .* is not allowed/);
  });

  it("normalizes dot segments before validating the path", () => {
    const result = buildSafeMissAvNavigationTarget(
      "https://missav.ai/dm2/../secret",
    );

    expect(result.path).toBe("/secret");
  });

  it("rejects more than one prefix segment before the video id", () => {
    expect(() =>
      buildSafeMissAvNavigationTarget("https://missav.ai/a/b/cn/video-id"),
    ).toThrow(/Invalid MissAV video path/);
  });

  it("rejects explicit ports", () => {
    expect(() =>
      buildSafeMissAvNavigationTarget("https://missav.ai:8443/cn/video-id"),
    ).toThrow(/credentials or explicit ports/);
  });
});
