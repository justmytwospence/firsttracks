import { describe, expect, it } from "vitest";
import {
  cn,
  convertKeysToCamelCase,
  formatSlope,
  gradientToSlopeAngle,
  slopeAngleToGradient,
} from "./utils";

describe("cn", () => {
  it("merges multiple class names", () => {
    expect(cn("class1", "class2")).toBe("class1 class2");
  });

  it("handles conditional class names", () => {
    expect(cn("base", false && "hidden", true && "visible")).toBe("base visible");
  });

  it("merges Tailwind classes correctly", () => {
    expect(cn("px-4", "px-6")).toBe("px-6");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("handles empty inputs", () => {
    expect(cn()).toBe("");
    expect(cn("")).toBe("");
  });

  it("handles arrays of class names", () => {
    expect(cn(["class1", "class2"])).toBe("class1 class2");
  });
});

describe("gradientToSlopeAngle", () => {
  it("converts 0 gradient to 0 degrees", () => {
    expect(gradientToSlopeAngle(0)).toBe(0);
  });

  it("converts 1.0 gradient (100%) to 45 degrees", () => {
    expect(gradientToSlopeAngle(1.0)).toBeCloseTo(45, 5);
  });

  it("converts 0.30 gradient (30%) to approximately 16.7 degrees", () => {
    expect(gradientToSlopeAngle(0.30)).toBeCloseTo(16.699, 2);
  });

  it("handles negative gradients", () => {
    expect(gradientToSlopeAngle(-0.30)).toBeCloseTo(-16.699, 2);
  });
});

describe("slopeAngleToGradient", () => {
  it("converts 0 degrees to 0 gradient", () => {
    expect(slopeAngleToGradient(0)).toBe(0);
  });

  it("converts 45 degrees to 1.0 gradient (100%)", () => {
    expect(slopeAngleToGradient(45)).toBeCloseTo(1.0, 5);
  });

  it("converts 16.699 degrees to approximately 0.30 gradient", () => {
    expect(slopeAngleToGradient(16.699)).toBeCloseTo(0.30, 2);
  });

  it("is the inverse of gradientToSlopeAngle", () => {
    const gradient = 0.5;
    const angle = gradientToSlopeAngle(gradient);
    expect(slopeAngleToGradient(angle)).toBeCloseTo(gradient, 10);
  });
});

describe("formatSlope", () => {
  it("formats as percentage by default", () => {
    expect(formatSlope(0.30, false)).toBe("30%");
    expect(formatSlope(0.50, false)).toBe("50%");
  });

  it("formats as degrees when useDegrees is true", () => {
    expect(formatSlope(0.30, true)).toBe("17°");
    expect(formatSlope(1.0, true)).toBe("45°");
  });

  it("respects decimal places for percentage", () => {
    expect(formatSlope(0.305, false, 1)).toBe("30.5%");
    expect(formatSlope(0.3333, false, 2)).toBe("33.33%");
  });

  it("respects decimal places for degrees", () => {
    expect(formatSlope(0.30, true, 1)).toBe("16.7°");
    expect(formatSlope(0.30, true, 2)).toBe("16.70°");
  });

  it("handles zero gradient", () => {
    expect(formatSlope(0, false)).toBe("0%");
    expect(formatSlope(0, true)).toBe("0°");
  });
});

describe("convertKeysToCamelCase", () => {
  it("converts snake_case keys to camelCase", () => {
    const input = { user_name: "john", user_age: 25 };
    expect(convertKeysToCamelCase(input)).toEqual({
      userName: "john",
      userAge: 25,
    });
  });

  it("handles nested objects", () => {
    const input = { user_data: { first_name: "john", last_name: "doe" } };
    expect(convertKeysToCamelCase(input)).toEqual({
      userData: { firstName: "john", lastName: "doe" },
    });
  });

  it("handles arrays", () => {
    const input = [{ user_id: 1 }, { user_id: 2 }];
    expect(convertKeysToCamelCase(input)).toEqual([
      { userId: 1 },
      { userId: 2 },
    ]);
  });

  it("handles arrays in objects", () => {
    const input = { user_list: [{ first_name: "john" }] };
    expect(convertKeysToCamelCase(input)).toEqual({
      userList: [{ firstName: "john" }],
    });
  });

  it("returns primitives unchanged", () => {
    expect(convertKeysToCamelCase("string")).toBe("string");
    expect(convertKeysToCamelCase(123)).toBe(123);
    expect(convertKeysToCamelCase(null)).toBe(null);
    expect(convertKeysToCamelCase(undefined)).toBe(undefined);
  });

  it("handles keys without underscores", () => {
    const input = { name: "john" };
    expect(convertKeysToCamelCase(input)).toEqual({ name: "john" });
  });

  it("handles multiple underscores", () => {
    const input = { user_first_name: "john" };
    expect(convertKeysToCamelCase(input)).toEqual({ userFirstName: "john" });
  });
});
