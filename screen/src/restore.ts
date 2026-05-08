import { osa } from "@meta/shared";

export async function frontmostApp(): Promise<string | null> {
  try {
    const out = await osa(`tell application "System Events" to get name of first application process whose frontmost is true`);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
