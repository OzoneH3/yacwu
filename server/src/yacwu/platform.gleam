//// Host OS operations used by the native Windows and Unix launch paths.

@external(erlang, "yacwu_platform", "is_windows")
pub fn is_windows() -> Bool

@external(erlang, "yacwu_platform", "home")
pub fn home() -> String

@external(erlang, "yacwu_platform", "state_home")
pub fn state_home() -> String

@external(erlang, "yacwu_platform", "temp_dir")
pub fn temp_dir() -> String

@external(erlang, "yacwu_platform", "normalize")
pub fn normalize(path: String) -> String

@external(erlang, "yacwu_platform", "is_absolute")
pub fn is_absolute(path: String) -> Bool

@external(erlang, "yacwu_platform", "windows_absolute")
pub fn windows_absolute(path: String) -> Bool

@external(erlang, "yacwu_platform", "resolve")
pub fn resolve(path: String, base: String) -> String

@external(erlang, "yacwu_platform", "restrict")
pub fn restrict(path: String, directory: Bool) -> Result(Nil, String)

/// Disallow Windows device namespaces, alternate data streams and ambiguous
/// drive-relative paths at the local folder boundary.
@external(erlang, "yacwu_platform", "valid_path")
pub fn valid_path(path: String) -> Bool

@external(erlang, "yacwu_platform", "windows_relative")
pub fn windows_relative(path: String) -> Bool
