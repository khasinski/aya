/** `text` as a literal inside a RegExp: every metacharacter escaped, backslash included. */
export const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
