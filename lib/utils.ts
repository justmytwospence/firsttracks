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