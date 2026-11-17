import envoy
import gleeunit

pub fn main() -> Nil {
  case envoy.get("YACWU_PORTABLE_TESTS") {
    Ok("1") -> portable_tests()
    _ -> gleeunit.main()
  }
}

// gleeunit test functions end in `_test`
pub fn hello_world_test() {
  let name = "Joe"
  let greeting = "Hello, " <> name <> "!"

  assert greeting == "Hello, Joe!"
}

@external(erlang, "yacwu_portable_tests", "run")
fn portable_tests() -> Nil
