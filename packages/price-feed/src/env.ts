import { ENV } from "@effectstream/utils/node-env";

/** Read an optional string, treating blank values the same as an unset variable. */
export function optionalString(name: string, fallback: string): string {
  const value = ENV.getString(name, "").trim();
  return value === "" ? fallback : value;
}

/** Preserve ENV.getNumber's parsing while making whitespace-only values optional. */
export function optionalNumber(name: string, fallback: number): number {
  const value = ENV.getString(name, "");
  return value.trim() === "" ? fallback : Number.parseInt(value, 10);
}
