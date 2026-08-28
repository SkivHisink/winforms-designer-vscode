import * as fs from 'node:fs';
import {
  V2_SOAK_PROFILES,
  V2SoakCycleObservation,
  V2SoakProfileId,
  V2SoakReport,
  makeDeterministicV2SoakCycleRunner,
  runV2SoakHarness,
  summarizeV2SoakMetrics,
  validateV2SoakReport,
} from './v2SoakHarness';

const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const ALLOWED_GA_INPUT_FIELDS = new Set([
  'schemaVersion',
  'generatedAtUtc',
  'elapsedMs',
  'observations',
]);
const GA_OBSERVATION_FIELDS = [
  'cycle',
  'privateBytes',
  'managedHeapBytes',
  'gdiHandles',
  'userHandles',
  'outputLocksHeld',
  'outputLockWaitMs',
  'crashRecoveries',
  'recoveryRequired',
  'workerGeneration',
  'buildChurnHash',
] as const;
const GA_OBSERVATION_FIELD_SET = new Set<string>(GA_OBSERVATION_FIELDS);
const GA_INTEGER_FIELDS = new Set<string>([
  'cycle',
  'gdiHandles',
  'userHandles',
  'outputLocksHeld',
  'outputLockWaitMs',
  'crashRecoveries',
  'recoveryRequired',
  'workerGeneration',
]);

export interface V2SoakCliIo {
  readonly readFileSync: (file: string) => Buffer;
  readonly writeFileSync: (file: string, data: string) => void;
  readonly stdout: (data: string) => void;
  readonly stderr: (data: string) => void;
}

export interface V2SoakCliOptions {
  readonly maxInputBytes?: number;
  readonly io?: V2SoakCliIo;
}

export interface V2SoakCliResult {
  readonly exitCode: number;
  readonly reportStatus?: string;
}

interface ParsedArgs {
  readonly profileId: V2SoakProfileId;
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly generatedAtUtc?: string;
}

export async function runV2SoakCli(
  argv: readonly string[] = process.argv.slice(2),
  options: V2SoakCliOptions = {},
): Promise<V2SoakCliResult> {
  const io = options.io ?? realIo;
  try {
    const args = parseArgs(argv);
    const report = args.profileId === 'ci-short'
      ? await runCiShort(args)
      : runGa8h(args, options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES, io);
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
  let profileId: V2SoakProfileId = 'ci-short';
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let generatedAtUtc: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') throw new Error(usage());
    if (arg === '--profile') {
      const value = requireValue(argv, ++index, arg);
      if (value !== 'ci-short' && value !== 'ga-8h') throw new Error(`unknown soak profile: ${value}`);
      profileId = value;
    } else if (arg === '--input' || arg === '-i') {
      inputPath = requireValue(argv, ++index, arg);
    } else if (arg === '--output' || arg === '-o') {
      outputPath = requireValue(argv, ++index, arg);
    } else if (arg === '--generated-at') {
      generatedAtUtc = requireValue(argv, ++index, arg);
    } else {
      throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (profileId === 'ci-short' && inputPath) {
    throw new Error('ci-short uses the deterministic synthetic runner and does not accept --input');
  }
  if (profileId === 'ga-8h' && !inputPath) {
    throw new Error('ga-8h requires --input real-product observation JSON');
  }
  if (profileId === 'ga-8h' && !outputPath) {
    throw new Error('ga-8h requires an explicit --output report path');
  }

  return { profileId, inputPath, outputPath, generatedAtUtc };
}

async function runCiShort(args: ParsedArgs): Promise<V2SoakReport> {
  return runV2SoakHarness(makeDeterministicV2SoakCycleRunner(), {
    profileId: 'ci-short',
    executionMode: 'synthetic-harness',
    generatedAtUtc: args.generatedAtUtc,
    nowMs: () => 0,
  });
}

function runGa8h(args: ParsedArgs, maxInputBytes: number, io: V2SoakCliIo): V2SoakReport {
  if (!args.inputPath) throw new Error('ga-8h requires --input real-product observation JSON');
  const input = readGa8hInput(args.inputPath, maxInputBytes, io);
  const profile = V2_SOAK_PROFILES['ga-8h'];
  const baseReport: Omit<V2SoakReport, 'status' | 'failures' | 'notExecuted'> = {
    schemaVersion: '2.0.0-soak-harness.1',
    profile,
    // A caller-supplied JSON file is useful for validating observation shape and budgets, but it is not a trusted
    // product runner and cannot attest its own elapsed time or hardware. Keep both GA evidence legs NOT_EXECUTED so a
    // deterministic/synthetic file cannot promote itself to release evidence. A future trusted runner must call the
    // harness from the live product path and archive its independently attributable evidence instead of using import.
    executionMode: 'external-observation-import',
    generatedAtUtc: args.generatedAtUtc ?? input.generatedAtUtc,
    elapsedMs: input.elapsedMs,
    evidence: {
      realProductPath: 'NOT_EXECUTED',
      hardware8hRun: 'NOT_EXECUTED',
    },
    observations: input.observations,
    summary: summarizeV2SoakMetrics(input.observations),
  };
  const validation = validateV2SoakReport({
    ...baseReport,
    status: 'NOT_EXECUTED',
    failures: [],
    notExecuted: [],
  });
  return {
    ...baseReport,
    status: validation.status,
    failures: validation.failures,
    notExecuted: validation.notExecuted,
  };
}

function readGa8hInput(
  inputPath: string,
  maxInputBytes: number,
  io: V2SoakCliIo,
): {
  readonly generatedAtUtc: string;
  readonly elapsedMs: number;
  readonly observations: readonly V2SoakCycleObservation[];
} {
  const buffer = io.readFileSync(inputPath);
  if (buffer.byteLength > maxInputBytes) throw new Error(`ga-8h observation file exceeds ${maxInputBytes} bytes`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`malformed ga-8h observation JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isPlainObject(parsed)) throw new Error('ga-8h observation JSON root must be an object');
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_GA_INPUT_FIELDS.has(key)) throw new Error(`unknown root field: ${key}`);
  }
  if (parsed.schemaVersion !== '2.0.0-soak-observations.1') {
    throw new Error('schemaVersion must be 2.0.0-soak-observations.1');
  }
  const generatedAtUtc = parsed.generatedAtUtc;
  const elapsedMs = parsed.elapsedMs;
  const observations = parsed.observations;
  if (typeof generatedAtUtc !== 'string' || generatedAtUtc.trim() === '') {
    throw new Error('generatedAtUtc must be a non-empty string');
  }
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error('elapsedMs must be a non-negative finite number captured from the real run');
  }
  if (!Array.isArray(observations)) throw new Error('observations must be an array');
  if (observations.length !== V2_SOAK_PROFILES['ga-8h'].requiredCycles) {
    throw new Error(`observations must contain ${V2_SOAK_PROFILES['ga-8h'].requiredCycles} ga-8h cycles`);
  }
  for (const [index, observation] of observations.entries()) {
    if (!isPlainObject(observation)) throw new Error(`observation ${index} must be an object`);
    for (const key of Object.keys(observation)) {
      if (!GA_OBSERVATION_FIELD_SET.has(key)) {
        throw new Error(`observation ${index} has unknown field: ${key}`);
      }
    }
    for (const field of GA_OBSERVATION_FIELDS) {
      if (!(field in observation)) throw new Error(`observation ${index} is missing ${field}`);
    }
    for (const field of GA_OBSERVATION_FIELDS) {
      const value = observation[field];
      if (field === 'buildChurnHash') {
        if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
          throw new Error(`observation ${index} has invalid buildChurnHash`);
        }
      } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`observation ${index} has invalid ${field}`);
      } else if (GA_INTEGER_FIELDS.has(field) && !Number.isInteger(value)) {
        throw new Error(`observation ${index} has non-integer ${field}`);
      }
    }
  }

  return {
    generatedAtUtc,
    elapsedMs,
    observations: observations as readonly V2SoakCycleObservation[],
  };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('-')) throw new Error(`missing value for ${flag}`);
  return value;
}

function usage(): string {
  return [
    'usage: node dist/v2-soak.cjs --profile ci-short [--output report.json] [--generated-at ISO-UTC]',
    'usage: node dist/v2-soak.cjs --profile ga-8h --input observations.json --output report.json',
    'ga-8h input schemaVersion: 2.0.0-soak-observations.1',
  ].join('\n');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const realIo: V2SoakCliIo = {
  readFileSync: (file) => fs.readFileSync(file),
  writeFileSync: (file, data) => fs.writeFileSync(file, data, 'utf8'),
  stdout: (data) => process.stdout.write(data),
  stderr: (data) => process.stderr.write(data),
};

if (typeof require !== 'undefined' && require.main === module) {
  void runV2SoakCli().then((result) => {
    process.exitCode = result.exitCode;
  });
}
