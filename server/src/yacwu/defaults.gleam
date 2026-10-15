//// Default config applied to every thread we create.
////
//// Sessions run in "yolo" mode: `approvalPolicy: "never"` so the web UI never
//// blocks on a terminal-style approval prompt, and
//// `sandbox: "danger-full-access"` so commands run with full access and no
//// sandboxing.

import gleam/json.{type Json}

pub const image_output_instructions = "When you need to show an image to the user, save it to a local file and include exactly one XML block containing its absolute path: <agent-img>/absolute/path/to/image.png</agent-img>. Put no markdown image syntax inside the block."

pub const new_session_model = "gpt-6.1-sol"

/// Claude sessions name their model explicitly: "default" floats with Claude
/// Code's account default, so usage could not tell which model it measured.
pub const new_claude_session_model = "claude-opus-5-5"

/// Copilot sessions start on Copilot's own model choice.
pub const new_copilot_session_model = "copilot/auto"
pub const new_session_effort = "medium"

pub fn thread_defaults() -> List(#(String, Json)) {
  [
    #("approvalPolicy", json.string("never")),
    #("sandbox", json.string("danger-full-access")),
    #("developerInstructions", json.string(image_output_instructions)),
  ]
}
