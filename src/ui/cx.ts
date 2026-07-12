/** Map space-separated local class names through a CSS Modules object. */
export function cx(
  styles: Record<string, string>,
  ...parts: Array<string | false | null | undefined>
): string {
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const name of part.trim().split(/\s+/)) {
      if (!name) continue;
      out.push(styles[name] ?? name);
    }
  }
  return out.join(" ");
}
