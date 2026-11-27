export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface OptionSpec {
  /** Long name without dashes. */
  name: string;
  short?: string;
  /** Flags take no value. */
  flag?: boolean;
}

export interface Parsed {
  positionals: string[];
  options: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[], specs: readonly OptionSpec[]): Parsed {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  const byLong = new Map(specs.map((s) => [s.name, s]));
  const byShort = new Map(specs.filter((s) => s.short).map((s) => [s.short as string, s]));
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let spec: OptionSpec | undefined;
    let inline: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) inline = arg.slice(eq + 1);
      spec = byLong.get(name);
      if (!spec) throw new UsageError(`unknown option ${arg}`);
    } else if (arg.startsWith("-") && arg.length > 1) {
      spec = byShort.get(arg.slice(1));
      if (!spec) throw new UsageError(`unknown option ${arg}`);
    } else {
      positionals.push(arg);
      continue;
    }
    if (spec.flag) {
      if (inline !== undefined) throw new UsageError(`--${spec.name} does not take a value`);
      options.set(spec.name, true);
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || (inline === undefined && value.startsWith("-") && value.length > 1)) {
      throw new UsageError(`--${spec.name} needs a value`);
    }
    options.set(spec.name, value);
  }
  return { positionals, options };
}

export function intOption(p: Parsed, name: string, min = 1): number | undefined {
  const v = p.options.get(name);
  if (v === undefined) return undefined;
  if (v === true || !/^\d+$/.test(v)) throw new UsageError(`--${name} must be a whole number`);
  const n = Number.parseInt(v, 10);
  if (n < min || !Number.isSafeInteger(n)) throw new UsageError(`--${name} must be at least ${min}`);
  return n;
}

export function stringOption(p: Parsed, name: string): string | undefined {
  const v = p.options.get(name);
  return v === undefined || v === true ? undefined : v;
}
