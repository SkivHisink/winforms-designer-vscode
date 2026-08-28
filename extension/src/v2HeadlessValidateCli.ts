import * as fs from 'node:fs';
import { runV2HeadlessValidation, V2HeadlessScenario } from './v2HeadlessValidate';

const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
const MAX_SCENARIOS = 128;
const ALLOWED_ROOT_FIELDS = new Set(['schemaVersion', 'generatedAtUtc', 'scenarios']);

export interface V2HeadlessValidateCliIo {
  readonly readFileSync: (file: string) => Buffer;
  readonly writeFileSync: (file: string, data: string) => void;
  readonly stdout: (data: string) => void;
  readonly stderr: (data: string) => void;
}

export interface V2HeadlessValidateCliOptions {
  readonly maxInputBytes?: number;
  readonly io?: V2HeadlessValidateCliIo;
}

export interface V2HeadlessValidateCliResult {
  readonly exitCode: number;
  readonly reportStatus?: string;
}

interface ParsedArgs {
  readonly inputPath: string;
  readonly outputPath?: string;
  readonly generatedAtUtc?: string;
}

export function runV2HeadlessValidateCli(
  argv: readonly string[] = process.argv.slice(2),
  options: V2HeadlessValidateCliOptions = {},
): V2HeadlessValidateCliResult {
  const io = options.io ?? realIo;
  try {
    const args = parseArgs(argv);
    const input = readScenarioFile(args.inputPath, options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES, io);
    const generatedAtUtc = args.generatedAtUtc ?? input.generatedAtUtc;
    const report = runV2HeadlessValidation(input.scenarios, generatedAtUtc ? { generatedAtUtc } : {});
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (args.outputPath) {
      io.writeFileSync(args.outputPath, serialized);
    } else {
      io.stdout(serialized);
    }
    return { exitCode: report.status === 'FAIL' ? 1 : 0, reportStatus: report.status };
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2 };
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let generatedAtUtc: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') throw new Error(usage());
    if (arg === '--input' || arg === '-i') {
      inputPath = requireValue(argv, ++index, arg);
    } else if (arg === '--output' || arg === '-o') {
      outputPath = requireValue(argv, ++index, arg);
    } else if (arg === '--generated-at') {
      generatedAtUtc = requireValue(argv, ++index, arg);
    } else {
      throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (!inputPath) throw new Error(`missing required --input path\n${usage()}`);
  return { inputPath, outputPath, generatedAtUtc };
}

function readScenarioFile(
  inputPath: string,
  maxInputBytes: number,
  io: V2HeadlessValidateCliIo,
): { readonly generatedAtUtc?: string; readonly scenarios: readonly V2HeadlessScenario[] } {
  const buffer = io.readFileSync(inputPath);
  if (buffer.byteLength > maxInputBytes) {
    throw new Error(`headless scenario file exceeds ${maxInputBytes} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`malformed headless scenario JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isPlainObject(parsed)) throw new Error('headless scenario JSON root must be an object');
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_ROOT_FIELDS.has(key)) throw new Error(`unknown root field: ${key}`);
  }
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== '2.0.0-headless-input.1') {
    throw new Error('schemaVersion must be 2.0.0-headless-input.1 when supplied');
  }
  if (parsed.generatedAtUtc !== undefined && typeof parsed.generatedAtUtc !== 'string') {
    throw new Error('generatedAtUtc must be a string when supplied');
  }
  if (!Array.isArray(parsed.scenarios)) throw new Error('scenarios must be an array');
  if (parsed.scenarios.length === 0) throw new Error('scenarios must not be empty');
  if (parsed.scenarios.length > MAX_SCENARIOS) {
    throw new Error(`scenarios exceeds maximum ${MAX_SCENARIOS}`);
  }
  for (const [index, scenario] of parsed.scenarios.entries()) {
    if (!isPlainObject(scenario)) throw new Error(`scenario ${index} must be an object`);
    if (typeof scenario.id !== 'string' || scenario.id.trim() === '') {
      throw new Error(`scenario ${index} must have a non-empty string id`);
    }
  }

  return {
    generatedAtUtc: parsed.generatedAtUtc,
    scenarios: parsed.scenarios as readonly V2HeadlessScenario[],
  };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('-')) throw new Error(`missing value for ${flag}`);
  return value;
}

function usage(): string {
  return [
    'usage: node dist/v2-headless-validate.cjs --input scenarios.json [--output report.json] [--generated-at ISO-UTC]',
    'input schemaVersion: 2.0.0-headless-input.1',
  ].join('\n');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const realIo: V2HeadlessValidateCliIo = {
  readFileSync: (file) => fs.readFileSync(file),
  writeFileSync: (file, data) => fs.writeFileSync(file, data, 'utf8'),
  stdout: (data) => process.stdout.write(data),
  stderr: (data) => process.stderr.write(data),
};

if (typeof require !== 'undefined' && require.main === module) {
  const result = runV2HeadlessValidateCli();
  process.exitCode = result.exitCode;
}
