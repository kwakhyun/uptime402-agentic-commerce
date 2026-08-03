/** Rejects duplicate object keys before JSON.parse can silently overwrite them. */
class DuplicateKeyScanner {
  private index = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.value("$");
    this.whitespace();
    if (this.index !== this.source.length) {
      throw new SyntaxError(`Unexpected JSON token at byte ${this.index}`);
    }
  }

  private whitespace(): void {
    while (/\s/u.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private value(path: string): void {
    this.whitespace();
    const character = this.source[this.index];
    if (character === "{") return this.object(path);
    if (character === "[") return this.array(path);
    if (character === '"') {
      this.string();
      return;
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
      this.source.slice(this.index),
    );
    if (!match) throw new SyntaxError(`Invalid JSON value at byte ${this.index}`);
    this.index += match[0].length;
  }

  private object(path: string): void {
    this.index += 1;
    this.whitespace();
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return;
    }
    while (true) {
      this.whitespace();
      if (this.source[this.index] !== '"') {
        throw new SyntaxError(`Expected object key at byte ${this.index}`);
      }
      const key = this.string();
      if (keys.has(key)) throw new SyntaxError(`Duplicate JSON key at ${path}.${key}`);
      keys.add(key);
      this.whitespace();
      if (this.source[this.index] !== ":") {
        throw new SyntaxError(`Expected colon at byte ${this.index}`);
      }
      this.index += 1;
      this.value(`${path}.${key}`);
      this.whitespace();
      if (this.source[this.index] === "}") {
        this.index += 1;
        return;
      }
      if (this.source[this.index] !== ",") {
        throw new SyntaxError(`Expected comma at byte ${this.index}`);
      }
      this.index += 1;
    }
  }

  private array(path: string): void {
    this.index += 1;
    this.whitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return;
    }
    let item = 0;
    while (true) {
      this.value(`${path}[${item}]`);
      item += 1;
      this.whitespace();
      if (this.source[this.index] === "]") {
        this.index += 1;
        return;
      }
      if (this.source[this.index] !== ",") {
        throw new SyntaxError(`Expected comma at byte ${this.index}`);
      }
      this.index += 1;
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.source.slice(start, this.index)) as string;
      }
      if (character === "\\") {
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === "u") {
          const hex = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
            throw new SyntaxError(`Invalid Unicode escape at byte ${this.index}`);
          }
          this.index += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) {
          throw new SyntaxError(`Invalid escape at byte ${this.index}`);
        }
      }
      if ((character?.charCodeAt(0) ?? 0) < 0x20) {
        throw new SyntaxError(`Control character in JSON string at byte ${this.index}`);
      }
      this.index += 1;
    }
    throw new SyntaxError("Unterminated JSON string");
  }
}

export function parseStrictJson(source: string): unknown {
  new DuplicateKeyScanner(source).scan();
  return JSON.parse(source) as unknown;
}

/**
 * Decodes an externally supplied JSON body without replacement characters,
 * enforces its byte ceiling before decoding, and rejects duplicate object keys
 * before any schema validation or canonical hashing can observe the value.
 */
export function parseBoundedStrictJsonBytes(
  bytes: Uint8Array,
  maxBytes: number,
  label = "JSON body",
): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("JSON byte limit must be a positive safe integer");
  }
  if (bytes.byteLength > maxBytes) {
    throw new RangeError(`${label} exceeds the configured byte limit`);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${label} is not valid UTF-8`);
  }
  return parseStrictJson(source);
}
