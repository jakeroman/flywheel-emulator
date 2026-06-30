// Native (.fwmod) module container: codec, integrity check, and loader.
export { crc32 } from "./crc32.js";
export {
  Arch,
  archName,
  decodeFwmod,
  FwModule,
  ABI_VERSION,
  FORMAT_VERSION,
  HEADER_SIZE,
  MAGIC,
  FLAG_PIC,
  type FwModuleFields,
} from "./format.js";
export {
  loadFwmod,
  SUPPORTED_ARCHS,
  type FwmodInspection,
  type NativeModuleInfo,
} from "./loader.js";
