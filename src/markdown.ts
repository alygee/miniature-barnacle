// Port of tdlib's legacy `parse_markdown` (td/telegram/MessageEntity.cpp) — the parser behind Bot API
// parse_mode=Markdown. Two deliberate deviations (spec §7.1):
//  1. `\_` is a literal `_` everywhere, including inside entities and URLs (tdlib only unescapes outside).
//  2. An unclosed entity keeps its opening delimiter as text instead of failing the whole message.

export type MdEntity =
  | { type: "bold" | "italic" | "code"; offset: number; length: number }
  | { type: "pre"; offset: number; length: number; language: string }
  | { type: "text_url"; offset: number; length: number; url: string };

export interface ParsedMarkdown {
  text: string;
  entities: MdEntity[];
}

const DELIMITERS = new Set(["_", "*", "`", "["]);

// td::is_space; `undefined` stands for the terminating '\0' tdlib reads past the end.
function isSpace(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  const code = ch.charCodeAt(0);
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || code === 11 || code === 0;
}

/** Offsets and lengths are UTF-16 code units, which is what JS string indices already are. */
export function parseLegacyMarkdown(source: string): ParsedMarkdown {
  const size = source.length;
  const entities: MdEntity[] = [];
  let text = "";
  let i = 0;

  while (i < size) {
    const ch = source[i]!;
    if (ch === "\\" && DELIMITERS.has(source[i + 1] ?? "")) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (!DELIMITERS.has(ch)) {
      text += ch;
      i++;
      continue;
    }

    // entity start
    const begin = i;
    const endChar = ch === "[" ? "]" : ch;
    let j = i + 1;
    let isPre = false;
    let language = "";
    if (ch === "`" && source[j] === "`" && source[j + 1] === "`") {
      j += 2;
      isPre = true;
      let languageEnd = j;
      while (!isSpace(source[languageEnd]) && source[languageEnd] !== "`") languageEnd++;
      if (j !== languageEnd && languageEnd < size && source[languageEnd] !== "`") {
        language = source.slice(j, languageEnd);
        j = languageEnd;
      }
      // skip one new line in the beginning of the text
      if (source[j] === "\n" || source[j] === "\r") {
        if ((source[j + 1] === "\n" || source[j + 1] === "\r") && source[j] !== source[j + 1]) j += 2;
        else j++;
      }
    }

    const bodyStart = j;
    let body = "";
    while (j < size && (source[j] !== endChar || (isPre && !(source[j + 1] === "`" && source[j + 2] === "`")))) {
      if (source[j] === "\\" && source[j + 1] === "_") {
        body += "_"; // deviation 1
        j += 2;
        continue;
      }
      body += source[j];
      j++;
    }
    if (j >= size) {
      text += source.slice(begin, bodyStart); // deviation 2
      i = bodyStart;
      continue;
    }

    const offset = text.length;
    text += body;
    let url = body; // `[url]` without `(…)` uses the text as URL
    if (ch === "[" && source[j + 1] === "(") {
      j += 2;
      url = "";
      while (j < size && source[j] !== ")") {
        if (source[j] === "\\" && source[j + 1] === "_") {
          url += "_"; // deviation 1
          j += 2;
          continue;
        }
        url += source[j];
        j++;
      }
    }

    if (body.length > 0) {
      const length = body.length;
      if (ch === "_") entities.push({ type: "italic", offset, length });
      else if (ch === "*") entities.push({ type: "bold", offset, length });
      else if (ch === "`") entities.push(isPre ? { type: "pre", offset, length, language } : { type: "code", offset, length });
      else {
        const checked = checkLink(url);
        if (checked !== undefined) entities.push({ type: "text_url", offset, length, url: checked });
      }
    }
    i = j + (isPre ? 3 : 1);
  }

  return { text, entities };
}

/** Approximates tdlib get_checked_link: default scheme http, web links need a dotted host (or localhost). */
export function checkLink(raw: string): string | undefined {
  const value = raw.trim();
  if (value === "") return undefined;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(tg|ton|mailto):/i.test(value);
  let url: URL;
  try {
    url = new URL(hasScheme ? value : `http://${value}`);
  } catch {
    return undefined;
  }
  switch (url.protocol) {
    case "http:":
    case "https:":
      return url.hostname.includes(".") || url.hostname === "localhost" ? url.href : undefined;
    case "tg:":
    case "ton:":
    case "mailto:":
      return value;
    default:
      return undefined;
  }
}
