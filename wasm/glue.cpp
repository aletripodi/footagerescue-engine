// WebAssembly glue for untrunc (FootageRescue). Not part of upstream untrunc.
//
// untrunc reports progress through the g_onProgress hook (used by its GUI).
// This file points that hook at a JavaScript function so the Web Worker can
// post progress messages while the repair runs. untrunc's own sources are
// compiled unchanged apart from the modifications listed in engine/CHANGES.md.

#include <emscripten.h>
#include <string>

extern void (*g_onProgress)(int);

EM_JS(void, untrunc_js_progress, (int percent), {
	if (Module.onUntruncProgress) Module.onUntruncProgress(percent);
});

namespace {
struct InstallProgressHook {
	InstallProgressHook() { g_onProgress = [](int p) { untrunc_js_progress(p); }; }
} install_progress_hook;
}
