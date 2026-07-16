/** Parse strict --name value CLI arguments into a map shared by release tools. */
export function parseNamedArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`unexpected argument: ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
    const key = name.slice(2);
    if (args.has(key)) throw new Error(`duplicate argument: ${name}`);
    args.set(key, value);
  }
  return args;
}

export function requireNamedArgs(args, required) {
  for (const name of required) {
    if (!args.has(name)) throw new Error(`--${name} is required`);
  }
  return args;
}
