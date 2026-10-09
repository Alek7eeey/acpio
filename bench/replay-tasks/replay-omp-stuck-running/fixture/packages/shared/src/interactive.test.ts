import { describe, expect, it } from "vitest";
import {
  isToolPermissionOption,
  permissionOptionsLookLikeQuestion,
  questionPayloadFromPermission,
} from "./interactive.js";

describe("interactive", () => {
  it("detects allow/reject permission options", () => {
    expect(isToolPermissionOption({ optionId: "allow_once", kind: "allow_once" })).toBe(true);
    expect(isToolPermissionOption({ optionId: "reject-once", kind: "reject_once" })).toBe(true);
    expect(isToolPermissionOption({ optionId: "bugbot", name: "Bugbot" })).toBe(false);
  });

  it("treats multi-choice non-permission options as questions", () => {
    expect(
      permissionOptionsLookLikeQuestion([
        { optionId: "bugbot", name: "Bugbot" },
        { optionId: "security", name: "Security" },
      ]),
    ).toBe(true);
    expect(
      permissionOptionsLookLikeQuestion([
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "reject_once", kind: "reject_once" },
      ]),
    ).toBe(false);
  });

  it("builds ask_question payload from permission params", () => {
    const payload = questionPayloadFromPermission(
      { title: "Review", message: "Which review?" },
      [
        { optionId: "bugbot", name: "Bugbot" },
        { optionId: "security", name: "Security" },
      ],
    );
    expect(payload.title).toBe("Review");
    expect(payload.questions).toHaveLength(1);
    const q = (payload.questions as Array<{ options: Array<{ id: string }> }>)[0];
    expect(q.options.map((o) => o.id)).toEqual(["bugbot", "security"]);
  });
});
