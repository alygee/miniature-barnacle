const NUMERIC_ID = /^[+-]?\d+$/;
const USERNAME = /^@[A-Za-z0-9_]{5,32}$/;

/**
 * Port of drone-telegram parseTo: plain ids always receive the message, `id:email` entries only when
 * the email matches the commit author; with matchEmail, any match restricts delivery to matched entries.
 * Extension: `@username` is accepted wherever a numeric id is.
 */
export function parseTo(
  to: readonly string[],
  authorEmail: string,
  matchEmail: boolean,
  warn: (message: string) => void = () => {},
): string[] {
  const ids: string[] = [];
  const emails: string[] = [];
  let attachEmail = true;

  for (const value of to.map((item) => item.trim()).filter((item) => item !== "")) {
    const parts = value
      .split(":")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const id = normalizeId(parts[0] ?? "");
    if (id === undefined) {
      warn(`skipping recipient "${value}": not a numeric id or @username`);
      continue;
    }
    if (parts.length > 1) {
      if (parts[1] !== authorEmail) continue;
      emails.push(id);
      attachEmail = false;
      continue;
    }
    ids.push(id);
  }

  if (matchEmail && !attachEmail) return emails;
  return [...ids, ...emails];
}

function normalizeId(value: string): string | undefined {
  if (NUMERIC_ID.test(value)) return BigInt(value).toString();
  if (USERNAME.test(value)) return value;
  return undefined;
}
