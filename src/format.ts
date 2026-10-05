import { Api } from "teleproto";
import { HTMLParser } from "teleproto/extensions/html.js";
import type { Format } from "./config.js";
import { type MdEntity, parseLegacyMarkdown } from "./markdown.js";

export const MAX_MESSAGE_LENGTH = 4096;

export interface FormattedMessage {
  text: string;
  entities: Api.TypeMessageEntity[];
}

export function toApiEntity(entity: MdEntity): Api.TypeMessageEntity {
  const { offset, length } = entity;
  switch (entity.type) {
    case "bold":
      return new Api.MessageEntityBold({ offset, length });
    case "italic":
      return new Api.MessageEntityItalic({ offset, length });
    case "code":
      return new Api.MessageEntityCode({ offset, length });
    case "pre":
      return new Api.MessageEntityPre({ offset, length, language: entity.language });
    case "text_url":
      return new Api.MessageEntityTextUrl({ offset, length, url: entity.url });
  }
}

/** MTProto has no server-side parse_mode: turn markup into plain text + entities here (spec §7). */
export function formatMessage(source: string, format: Format): FormattedMessage {
  let result: FormattedMessage;
  if (format === "html") {
    const [text, entities] = HTMLParser.parse(source);
    result = { text, entities };
  } else {
    const parsed = parseLegacyMarkdown(source);
    result = { text: parsed.text, entities: parsed.entities.map(toApiEntity) };
  }
  if (result.text.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`message too long (${result.text.length} > ${MAX_MESSAGE_LENGTH})`);
  }
  return result;
}
