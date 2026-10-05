export type Redactor = (text: string) => string;

/** Replaces secret values with <redacted>. Values shorter than 4 chars are ignored to avoid mangling output. */
export function makeRedactor(secrets: ReadonlyArray<string | undefined>): Redactor {
  const values = secrets
    .filter((secret): secret is string => typeof secret === "string" && secret.trim().length >= 4)
    .sort((a, b) => b.length - a.length);
  return (text) => values.reduce((acc, secret) => acc.split(secret).join("<redacted>"), text);
}
