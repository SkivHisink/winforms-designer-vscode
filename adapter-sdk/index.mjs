import { Buffer } from 'node:buffer';

export const SDK_VERSION = '0.1.0';
export const PACKAGE_SCHEMA_ID = 'winforms-designer.adapter-package';
export const PACKAGE_SCHEMA_VERSION = 1;
export const PROTOCOL_ID = 'winforms-designer.adapter-stdio';
export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 65_536;
export const MAX_PACKAGE_FILES = 16;
export const MAX_PACKAGE_FILE_BYTES = 1_048_576;
export const MAX_PACKAGE_BYTES = 4_194_304;
export const MAX_EXECUTION_MS = 5_000;
export const MAX_INVARIANT_BYTES = 8_192;
export const PROPERTY_TYPES = Object.freeze(['System.String', 'System.Boolean', 'System.Int32']);
export const CAPABILITIES = Object.freeze(['action.set-property', 'editor.scalar']);
export const SERVICE_IDS = Object.freeze(['ContainerSiting', 'Naming', 'ComponentChange', 'Selection', 'Transactions',
  'MenuCommands', 'ToolboxCatalog', 'TypeResolution', 'PropertySerialization']);

const identity = /^[a-z][a-z0-9.-]{2,95}$/;
const symbol = /^(?:this|[A-Za-z_][A-Za-z0-9_]{0,127})$/;
const stableCode = /^[A-Z][A-Z0-9_]{2,95}$/;
const sha256 = /^[a-f0-9]{64}$/;
const version = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** A declaration does not verify bytes, trust, or execution authority. The host must independently check all three. */
export function validateAdapterPackage(candidate) {
  const errors = [];
  const fail = (code, at) => errors.push({ code, path: at });
  if (!object(candidate, ['schemaId', 'schemaVersion', 'sdkVersion', 'adapter', 'cohort', 'execution',
    'integrity', 'provenance', 'capabilities', 'contributions', 'requiredServices'], '$', fail,
  ['schemaId', 'schemaVersion', 'sdkVersion', 'adapter', 'cohort', 'execution', 'integrity', 'provenance', 'capabilities', 'contributions'])) return invalid(errors);
  equal(candidate.schemaId, PACKAGE_SCHEMA_ID, '$.schemaId', fail);
  equal(candidate.schemaVersion, PACKAGE_SCHEMA_VERSION, '$.schemaVersion', fail);
  equal(candidate.sdkVersion, SDK_VERSION, '$.sdkVersion', fail, 'ADAPTER_SDK_UNSUPPORTED');
  if (object(candidate.adapter, ['id', 'version', 'displayName'], '$.adapter', fail)) {
    match(candidate.adapter.id, identity, '$.adapter.id', fail);
    semver(candidate.adapter.version, '$.adapter.version', fail);
    title(candidate.adapter.displayName, '$.adapter.displayName', fail);
  }
  if (object(candidate.cohort, ['productId', 'minProductVersion', 'maxProductVersionExclusive', 'runtimes', 'architectures'], '$.cohort', fail)) {
    equal(candidate.cohort.productId, 'winforms-designer-vscode', '$.cohort.productId', fail);
    const min = semver(candidate.cohort.minProductVersion, '$.cohort.minProductVersion', fail);
    const max = semver(candidate.cohort.maxProductVersionExclusive, '$.cohort.maxProductVersionExclusive', fail);
    if (min && max && compareVersions(min, max) >= 0) fail('ADAPTER_PACKAGE_INVALID', '$.cohort');
    stringSet(candidate.cohort.runtimes, ['modern', 'net48'], '$.cohort.runtimes', fail, 2);
    stringSet(candidate.cohort.architectures, ['x64', 'arm64'], '$.cohort.architectures', fail, 2);
  }
  if (object(candidate.execution, ['kind', 'entrypoint'], '$.execution', fail)) {
    equal(candidate.execution.kind, 'node-stdio', '$.execution.kind', fail);
    if (!isPackagePath(candidate.execution.entrypoint) || !candidate.execution.entrypoint.endsWith('.mjs'))
      fail('ADAPTER_PATH_INVALID', '$.execution.entrypoint');
  }
  const paths = new Set();
  if (object(candidate.integrity, ['algorithm', 'files'], '$.integrity', fail)) {
    equal(candidate.integrity.algorithm, 'sha256', '$.integrity.algorithm', fail);
    if (!Array.isArray(candidate.integrity.files) || candidate.integrity.files.length < 1 || candidate.integrity.files.length > MAX_PACKAGE_FILES) {
      fail('ADAPTER_PACKAGE_INVALID', '$.integrity.files');
    } else {
      candidate.integrity.files.forEach((file, index) => {
        const at = `$.integrity.files[${index}]`;
        if (!object(file, ['path', 'sha256'], at, fail)) return;
        if (!isPackagePath(file.path) || file.path === 'adapter-package.json') fail('ADAPTER_PATH_INVALID', `${at}.path`);
        if (typeof file.path === 'string') {
          const key = file.path.toLowerCase();
          if (paths.has(key)) fail('ADAPTER_PACKAGE_DUPLICATE', `${at}.path`);
          paths.add(key);
        }
        match(file.sha256, sha256, `${at}.sha256`, fail);
      });
    }
  }
  if (typeof candidate.execution?.entrypoint === 'string' && !paths.has(candidate.execution.entrypoint.toLowerCase()))
    fail('ADAPTER_PACKAGE_INVALID', '$.execution.entrypoint');
  if (object(candidate.provenance, ['policy', 'certification'], '$.provenance', fail)) {
    equal(candidate.provenance.policy, 'local-development', '$.provenance.policy', fail, 'ADAPTER_PROVENANCE_UNSUPPORTED');
    equal(candidate.provenance.certification, 'none', '$.provenance.certification', fail, 'ADAPTER_PROVENANCE_UNSUPPORTED');
  }
  stringSet(candidate.capabilities, CAPABILITIES, '$.capabilities', fail, CAPABILITIES.length);
  if (Object.hasOwn(candidate, 'requiredServices')) {
    if (!Array.isArray(candidate.requiredServices) || candidate.requiredServices.length > SERVICE_IDS.length
      || new Set(candidate.requiredServices).size !== candidate.requiredServices.length
      || candidate.requiredServices.some(id => !SERVICE_IDS.includes(id))) fail('ADAPTER_SERVICE_UNSUPPORTED', '$.requiredServices');
  }
  if (object(candidate.contributions, ['actions', 'editors'], '$.contributions', fail)) {
    const contributionIds = new Set();
    for (const [key, capability] of [['actions', 'action.set-property'], ['editors', 'editor.scalar']]) {
      const list = candidate.contributions[key];
      if (!Array.isArray(list) || list.length > 16) {
        fail('ADAPTER_PACKAGE_INVALID', `$.contributions.${key}`);
        continue;
      }
      const declared = Array.isArray(candidate.capabilities) && candidate.capabilities.includes(capability);
      if (list.length && !declared) fail('ADAPTER_CAPABILITY_UNDECLARED', `$.contributions.${key}`);
      if (!list.length && declared) fail('ADAPTER_CAPABILITY_UNUSED', `$.capabilities`);
      list.forEach((item, index) => {
        const at = `$.contributions.${key}[${index}]`;
        const keys = ['id', 'title', 'propertyName', 'propertyType', 'disabledReasonCode'];
        if (key === 'editors') keys.push('presentation', 'choices');
        if (!object(item, keys, at, fail, ['id', 'title', 'propertyName', 'propertyType'])) return;
        match(item.id, identity, `${at}.id`, fail);
        title(item.title, `${at}.title`, fail);
        match(item.propertyName, symbol, `${at}.propertyName`, fail);
        member(item.propertyType, PROPERTY_TYPES, `${at}.propertyType`, fail);
        if (Object.hasOwn(item, 'disabledReasonCode')) match(item.disabledReasonCode, stableCode, `${at}.disabledReasonCode`, fail);
        if (key === 'editors') {
          if (Object.hasOwn(item, 'presentation')) member(item.presentation, ['input', 'dropdown'], `${at}.presentation`, fail);
          if (item.presentation === 'dropdown') {
            if (!Array.isArray(item.choices) || item.choices.length < 1 || item.choices.length > 32 || new Set(item.choices).size !== item.choices.length)
              fail('ADAPTER_PACKAGE_INVALID', `${at}.choices`);
            else item.choices.forEach((value, choice) => scalar(item.propertyType, value, `${at}.choices[${choice}]`, fail));
          } else if (Object.hasOwn(item, 'choices')) fail('ADAPTER_PACKAGE_INVALID', `${at}.choices`);
        }
        if (contributionIds.has(item.id)) fail('ADAPTER_PACKAGE_DUPLICATE', `${at}.id`);
        contributionIds.add(item.id);
      });
    }
    if ((candidate.contributions.actions?.length ?? 0) + (candidate.contributions.editors?.length ?? 0) === 0)
      fail('ADAPTER_PACKAGE_INVALID', '$.contributions');
  }
  return errors.length ? invalid(errors) : { ok: true, value: candidate };
}

export function validateAdapterRequest(candidate, contribution) {
  const errors = [];
  const fail = (code, at) => errors.push({ code, path: at });
  if (!object(candidate, ['protocolId', 'protocolVersion', 'id', 'operation', 'contributionId', 'context', 'input'], '$', fail)) return invalid(errors);
  envelope(candidate, fail);
  member(candidate.operation, ['invokeAction', 'editProperty'], '$.operation', fail);
  match(candidate.contributionId, identity, '$.contributionId', fail);
  if (object(candidate.context, ['componentId', 'propertyName', 'propertyType', 'invariantValue', 'revision'], '$.context', fail)) {
    match(candidate.context.componentId, symbol, '$.context.componentId', fail);
    match(candidate.context.propertyName, symbol, '$.context.propertyName', fail);
    scalar(candidate.context.propertyType, candidate.context.invariantValue, '$.context', fail);
    if (!Number.isSafeInteger(candidate.context.revision) || candidate.context.revision < 0) fail('ADAPTER_REQUEST_INVALID', '$.context.revision');
  }
  if (object(candidate.input, ['invariantValue', 'cancel'], '$.input', fail, [])) {
    if ('invariantValue' in candidate.input && (typeof candidate.input.invariantValue !== 'string' || Buffer.byteLength(candidate.input.invariantValue) > MAX_INVARIANT_BYTES))
      fail('ADAPTER_REQUEST_INVALID', '$.input.invariantValue');
    if ('cancel' in candidate.input && typeof candidate.input.cancel !== 'boolean') fail('ADAPTER_REQUEST_INVALID', '$.input.cancel');
    if ('invariantValue' in candidate.input && contribution?.presentation === 'dropdown'
      && (!Array.isArray(contribution.choices) || !contribution.choices.includes(candidate.input.invariantValue)))
      fail('ADAPTER_EDITOR_CHOICE_INVALID', '$.input.invariantValue');
  }
  bounded(candidate, fail);
  return errors.length ? invalid(errors) : { ok: true, value: candidate };
}

/** Checks the selected target/type as well as the wire shape. An ok response remains a proposal, never a write. */
export function validateAdapterResponse(candidate, request, contribution) {
  const errors = [];
  const fail = (code, at) => errors.push({ code, path: at });
  if (request && !validateAdapterRequest(request).ok) return invalid([{ code: 'ADAPTER_REQUEST_INVALID', path: '$.request' }]);
  const status = candidate?.status;
  const fields = status === 'ok' ? ['intent'] : status === 'refused' ? ['code'] : [];
  if (!object(candidate, ['protocolId', 'protocolVersion', 'id', 'status', ...fields], '$', fail)) return invalid(errors);
  envelope(candidate, fail);
  member(status, ['ok', 'refused', 'cancelled'], '$.status', fail);
  if (request && candidate.id !== request.id) fail('ADAPTER_RESPONSE_ID_MISMATCH', '$.id');
  if (status === 'refused') match(candidate.code, stableCode, '$.code', fail);
  if (status === 'ok' && object(candidate.intent, ['kind', 'componentId', 'propertyName', 'propertyType', 'invariantValue'], '$.intent', fail)) {
    const intent = candidate.intent;
    equal(intent.kind, 'setProperty', '$.intent.kind', fail);
    match(intent.componentId, symbol, '$.intent.componentId', fail);
    match(intent.propertyName, symbol, '$.intent.propertyName', fail);
    scalar(intent.propertyType, intent.invariantValue, '$.intent', fail);
    if (request && (intent.componentId !== request.context.componentId || intent.propertyName !== request.context.propertyName))
      fail('ADAPTER_RESULT_TARGET_MISMATCH', '$.intent');
    if (request && intent.propertyType !== request.context.propertyType || contribution && intent.propertyType !== contribution.propertyType)
      fail('ADAPTER_RESULT_TYPE_MISMATCH', '$.intent.propertyType');
    if (contribution && intent.propertyName !== contribution.propertyName) fail('ADAPTER_RESULT_TARGET_MISMATCH', '$.intent.propertyName');
    if (contribution?.presentation === 'dropdown'
      && (!Array.isArray(contribution.choices) || !contribution.choices.includes(intent.invariantValue)))
      fail('ADAPTER_EDITOR_CHOICE_INVALID', '$.intent.invariantValue');
    if (request?.input.cancel === true) fail('ADAPTER_CANCEL_IGNORED', '$.status');
  }
  bounded(candidate, fail);
  return errors.length ? invalid(errors) : { ok: true, value: candidate };
}

/** Portable relative package path, including rejection of NTFS streams, device names, and casing aliases. */
export function isPackagePath(value) {
  return typeof value === 'string' && value.length <= 240 && !value.includes('\\') && !value.includes(':')
    && value.split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part)
      && !part.endsWith('.') && !part.endsWith(' ') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

/** A fresh child handles one bounded line and exits. It has normal OS privileges; this is not a sandbox. */
export async function serveAdapter(handler, { input = process.stdin, output = process.stdout } = {}) {
  let bytes = Buffer.alloc(0);
  let complete = false;
  for await (const chunk of input) {
    bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
    if (bytes.length > MAX_MESSAGE_BYTES) throw new Error('ADAPTER_MESSAGE_TOO_LARGE');
    const newline = bytes.indexOf(10);
    if (newline < 0) continue;
    if (complete || bytes.subarray(newline + 1).some(byte => byte !== 10 && byte !== 13 && byte !== 32))
      throw new Error('ADAPTER_MULTIPLE_REQUESTS');
    complete = true;
    const requestValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline)));
    const validated = validateAdapterRequest(requestValue);
    if (!validated.ok) throw new Error(validated.diagnostics[0].code);
    const request = validated.value;
    const response = await handler(request);
    const result = validateAdapterResponse(response, request);
    if (!result.ok) throw new Error(result.diagnostics[0].code);
    output.write(`${JSON.stringify(result.value)}\n`);
    return;
  }
  if (!complete) throw new Error('ADAPTER_REQUEST_INCOMPLETE');
}

export function responseFor(request, result) {
  return { protocolId: PROTOCOL_ID, protocolVersion: PROTOCOL_VERSION, id: request.id, ...result };
}

function object(value, keys, at, fail, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('ADAPTER_OBJECT_INVALID', at); return false;
  }
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail('ADAPTER_FIELD_UNKNOWN', `${at}.${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail('ADAPTER_FIELD_REQUIRED', `${at}.${key}`);
  return true;
}
function equal(value, expected, at, fail, code = 'ADAPTER_PACKAGE_INVALID') { if (value !== expected) fail(code, at); }
function match(value, pattern, at, fail) { if (typeof value !== 'string' || !pattern.test(value)) fail('ADAPTER_FIELD_INVALID', at); }
function title(value, at, fail) { if (typeof value !== 'string' || value.length < 1 || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) fail('ADAPTER_FIELD_INVALID', at); }
function member(value, options, at, fail) { if (!options.includes(value)) fail('ADAPTER_FIELD_INVALID', at); }
function stringSet(value, options, at, fail, maximum) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum || new Set(value).size !== value.length || value.some(item => !options.includes(item))) fail('ADAPTER_FIELD_INVALID', at);
}
function semver(value, at, fail) {
  const parts = typeof value === 'string' && value.length <= 48 ? version.exec(value)?.slice(1).map(Number) : undefined;
  if (!parts || !parts.every(Number.isSafeInteger)) { fail('ADAPTER_FIELD_INVALID', at); return null; }
  return parts;
}
function compareVersions(left, right) { for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]; return 0; }
function envelope(value, fail) {
  equal(value.protocolId, PROTOCOL_ID, '$.protocolId', fail, 'ADAPTER_PROTOCOL_UNSUPPORTED');
  equal(value.protocolVersion, PROTOCOL_VERSION, '$.protocolVersion', fail, 'ADAPTER_PROTOCOL_UNSUPPORTED');
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9-]{1,96}$/.test(value.id)) fail('ADAPTER_FIELD_INVALID', '$.id');
}
function scalar(type, value, at, fail) {
  member(type, PROPERTY_TYPES, `${at}.propertyType`, fail);
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_INVARIANT_BYTES) { fail('ADAPTER_RESULT_VALUE_INVALID', `${at}.invariantValue`); return; }
  if (type === 'System.Boolean' && value !== 'True' && value !== 'False') fail('ADAPTER_RESULT_VALUE_INVALID', `${at}.invariantValue`);
  if (type === 'System.Int32' && (!/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(value) || Number(value) < -2_147_483_648 || Number(value) > 2_147_483_647))
    fail('ADAPTER_RESULT_VALUE_INVALID', `${at}.invariantValue`);
}
function bounded(value, fail) { try { if (Buffer.byteLength(JSON.stringify(value)) + 1 > MAX_MESSAGE_BYTES) fail('ADAPTER_MESSAGE_TOO_LARGE', '$'); } catch { fail('ADAPTER_MESSAGE_INVALID', '$'); } }
function invalid(diagnostics) { return { ok: false, diagnostics }; }
