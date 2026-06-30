;; hello-wasm.wat - a Flywheel native module, hand-authored in WebAssembly text.
;;
;; This is the wasm32 analog of hello.c and pins the wasm32 module ABI the
;; WasmModuleRuntime speaks (and that the future clang shim header must match):
;;
;;   - The module EXPORTS its linear memory as "memory" (clang's default).
;;   - Host-provided fw_api calls are wasm IMPORTS from module "env" (the names
;;     mirror fw_api_t; the runtime supplies the full set, a module imports the
;;     subset it uses).
;;   - Function pointers live in the exported "__indirect_function_table"; a C
;;     function pointer is a table index. The fw_module_t struct is therefore
;;     three consecutive i32 table indices {init, update, draw} in memory.
;;   - THE entry "fw_main" takes the api arg (ignored in wasm; host passes 0)
;;     and returns the i32 pointer to that struct. NULL (0) means init failed.
;;
;; Regenerate the .fwmod fixture: node fixtures/make_wasm_fixture.mjs
(module
  (import "env" "cls"   (func $cls   (param i32)))
  (import "env" "rect"  (func $rect  (param i32 i32 i32 i32 i32)))
  (import "env" "print" (func $print (param i32 i32 i32 i32)))
  (import "env" "log"   (func $log   (param i32)))
  (import "env" "tone"  (func $tone  (param i32 i32)))
  (import "env" "btnp"  (func $btnp  (param i32) (result i32)))

  (memory (export "memory") 2)

  (table (export "__indirect_function_table") 3 funcref)
  (elem (i32.const 0) $init $update $draw)

  ;; data: NUL-terminated strings, and the fw_module_t struct {0,1,2} (LE i32s)
  (data (i32.const 16) "init\00")
  (data (i32.const 32) "HELLO FROM WASM\00")
  (data (i32.const 64) "\00\00\00\00\01\00\00\00\02\00\00\00")

  (func $init
    (call $log (i32.const 16)))

  (func $update (param $dt f32)
    (if (call $btnp (i32.const 4))               ;; FW_BTN_A
      (then (call $tone (i32.const 440) (i32.const 100)))))

  (func $draw
    (call $cls (i32.const 0))
    (call $rect (i32.const 2) (i32.const 2) (i32.const 20) (i32.const 20) (i32.const 1))
    (call $print (i32.const 32) (i32.const 10) (i32.const 10) (i32.const 1)))

  (func $fw_main (export "fw_main") (param i32) (result i32)
    (i32.const 64)))
