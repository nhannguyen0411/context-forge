const TOKEN_PATTERN = /[\p{L}\p{N}_./:-]+/gu;

export function tokenize(value: string): string[] {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(TOKEN_PATTERN) ?? []
  ).filter((token) => token.length > 1);
}

export function toFtsQuery(value: string): string | undefined {
  const tokens = [...new Set(tokenize(value))].slice(0, 24);
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export function tokenOverlap(query: string, candidate: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const candidateTokens = new Set(tokenize(candidate));
  let matches = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) matches += 1;
  }
  return matches / queryTokens.size;
}

export function chunkText(value: string, maxCharacters = 1_200): string[] {
  const paragraphs = value
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxCharacters) {
      flush();
      for (let offset = 0; offset < paragraph.length; offset += maxCharacters) {
        chunks.push(paragraph.slice(offset, offset + maxCharacters));
      }
      continue;
    }

    const combined = current ? `${current}\n\n${paragraph}` : paragraph;
    if (combined.length > maxCharacters) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }

  flush();
  return chunks.length > 0 ? chunks : [value];
}
