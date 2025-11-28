import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Convert gradient (rise/run ratio) to slope angle in degrees
 * e.g., 0.30 (30%) → 16.7°
 */
export function gradientToSlopeAngle(gradient: number): number {
  return Math.atan(gradient) * (180 / Math.PI);
}

/**
 * Convert slope angle in degrees to gradient (rise/run ratio)
 * e.g., 16.7° → 0.30 (30%)
 */
export function slopeAngleToGradient(angle: number): number {
  return Math.tan(angle * (Math.PI / 180));
}

/**
 * Format a gradient value for display based on user preference
 * @param gradient - The gradient as a ratio (e.g., 0.30 for 30%)
 * @param useDegrees - If true, display as slope angle in degrees; otherwise as percentage
 * @param decimals - Number of decimal places (default 0)
 */
export function formatSlope(gradient: number, useDegrees: boolean, decimals = 0): string {
  if (useDegrees) {
    const angle = gradientToSlopeAngle(gradient);
    return `${angle.toFixed(decimals)}°`;
  }
  return `${(gradient * 100).toFixed(decimals)}%`;
}

type SnakeToCamelCase<S extends string> = S extends `${infer T}_${infer U}`
  ? `${T}${Capitalize<SnakeToCamelCase<U>>}`
  : S;

type ConvertKeysToCamelCase<T> = T extends Array<infer U>
  ? Array<ConvertKeysToCamelCase<U>>
  : T extends object
  ? {
    [K in keyof T as SnakeToCamelCase<string & K>]: T[K] extends
    | object
    | Array<any>
    ? ConvertKeysToCamelCase<T[K]>
    : T[K];
  }
  : T;

function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

export function convertKeysToCamelCase<T>(obj: T): ConvertKeysToCamelCase<T> {
  if (Array.isArray(obj)) {
    return obj.map((item) =>
      convertKeysToCamelCase(item)
    ) as ConvertKeysToCamelCase<T>;
  } 
  
  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj).reduce((acc, key) => {
      const camelKey = toCamelCase(key);
      acc[camelKey] = convertKeysToCamelCase((obj as any)[key]);
      return acc;
    }, {} as ConvertKeysToCamelCase<T>);
  }
  return obj as ConvertKeysToCamelCase<T>;
}